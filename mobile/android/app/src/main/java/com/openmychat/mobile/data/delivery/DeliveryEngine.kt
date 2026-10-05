package com.openmychat.mobile.data.delivery

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * Runs the delivery model (delivery-state.md) for the whole process: one serial queue of events
 * through [DeliveryReducer], and the effects executed strictly in order (§5) — the `persist` barrier
 * first (nothing else runs until the slices are on disk), then socket frames, HTTP requests, alarms,
 * sync chains and history loads, whose results come back as events through the same queue.
 *
 * Every sender — the foreground socket pump and the background HTTP flush (WorkManager) — goes
 * through this one queue, so an outbox entry is never sent twice at once: the reducer moves it to
 * `sending` in the same step that emits the send, and a later step sees that.
 */
class DeliveryEngine(
    private val scope: CoroutineScope,
    private val store: DeliveryStore,
    private val link: DeliveryLink,
    private val backend: DeliveryBackend,
    private val clock: () -> Long = System::currentTimeMillis,
    /** How long cache writes of live messages are batched. */
    private val cacheDelayMs: Long = 1_000L
) {
    /** What one event did: its effects, and whether its state reached the disk (§5 persist). */
    class Outcome(val persisted: Boolean, val effects: List<DeliveryEffect>) {
        /** `enqueue` was taken: the entry is on disk and the composer may clear (§7.4). */
        val composerCleared: Boolean get() = persisted && effects.any { it is DeliveryEffect.ClearComposer }
        val userError: String? get() = effects.filterIsInstance<DeliveryEffect.UserError>().firstOrNull()?.code
    }

    private sealed interface Command
    private class Dispatch(val event: JsonObject, val done: CompletableDeferred<Outcome>?) : Command
    private class ReplaceHistory(val conversation: String, val records: List<JsonObject>, val stale: Set<Long>, val done: CompletableDeferred<Outcome>) : Command
    private class Reset(val done: CompletableDeferred<Unit>) : Command
    private object Restore : Command
    private object FlushCache : Command

    private val inbox = Channel<Command>(Channel.UNLIMITED)
    private var current = DeliveryState()
    private val _state = MutableStateFlow(current)

    /** The model after the last processed event. Never mutate it. */
    val state: StateFlow<DeliveryState> = _state.asStateFlow()

    private val _ready = MutableStateFlow(false)

    /** The stored model is loaded and `app_restart` applied. */
    val ready: StateFlow<Boolean> = _ready.asStateFlow()

    private val _userErrors = MutableSharedFlow<String>(extraBufferCapacity = 16)

    /** `user_error` codes (§5) to show. */
    val userErrors: SharedFlow<String> = _userErrors.asSharedFlow()

    /** Requests and alarms of this session; cancelled together when the session ends. */
    private var work = newWork()

    private fun newWork() = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
    @Volatile private var epoch = 0
    private var lastNow = 0L
    private val alarms: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()
    private val dirtyCache = LinkedHashSet<String>()
    private var cacheFlushScheduled = false
    private var started = false

    /** Subscribes to the socket and loads the stored model. Frames that arrive meanwhile wait in order. */
    @Synchronized
    fun start() {
        if (started) return
        started = true
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            link.frames.collect { frame -> inbox.trySend(Dispatch(frameEvent(frame), null)) }
        }
        inbox.trySend(Restore)
        scope.launch {
            for (command in inbox) {
                try {
                    run(command)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // One broken event must not stop delivery for the rest of the process.
                    (command as? Dispatch)?.done?.complete(Outcome(false, emptyList()))
                }
            }
        }
    }

    suspend fun awaitReady() {
        ready.first { it }
    }

    /** Processes [event] (its `now` is added) after everything queued before it; returns what it did. */
    suspend fun dispatch(event: JsonObject): Outcome {
        val done = CompletableDeferred<Outcome>()
        inbox.trySend(Dispatch(event, done))
        return done.await()
    }

    /** Fire and forget. */
    fun post(event: JsonObject) {
        inbox.trySend(Dispatch(event, null))
    }

    // ── user actions ────────────────────────────────────────────────────────────────────────

    /** `enqueue` (§6.3). [Outcome.composerCleared] — the message is on disk. */
    suspend fun enqueue(
        conversation: String,
        text: String,
        msgType: String = "text",
        replyToId: Long? = null,
        metadata: JsonObject? = null,
        clientMsgId: String = newClientMsgId()
    ): Outcome = dispatch(event("enqueue") {
        put("client_msg_id", clientMsgId)
        put("conversation", conversation)
        put("text", text)
        put("msgType", msgType)
        put("reply_to_id", replyToId?.let(::JsonPrimitive) ?: JsonNull)
        put("metadata", metadata ?: JsonNull)
    })

    suspend fun editSent(messageId: Long, text: String): Outcome = dispatch(event("edit") {
        put("message_id", messageId)
        put("text", text)
    })

    suspend fun delete(messageId: Long): Outcome = dispatch(event("delete") { put("message_id", messageId) })

    suspend fun cancel(clientMsgId: String): Outcome = dispatch(event("cancel") { put("client_msg_id", clientMsgId) })

    suspend fun retry(clientMsgId: String): Outcome = dispatch(event("retry") {
        put("client_msg_id", clientMsgId)
        put("new_client_msg_id", newClientMsgId())
    })

    fun conversationOpened(conversation: String) = post(event("conversation_opened") { put("conversation", conversation) })

    fun conversationClosed() = post(event("conversation_closed") {})

    /** A page of a conversation loaded by the screen (`history_page`). */
    suspend fun historyPage(records: List<JsonObject>): Outcome = dispatch(event("history_page") { put("body", JsonArray(records)) })

    /**
     * The latest page of [conversation] replaces what was cached: messages in [stale] (shown before
     * the request) that the page no longer has are dropped — hidden by a block, or older than the
     * page — then the page is applied as `history_page`.
     */
    suspend fun replaceHistory(conversation: String, records: List<JsonObject>, stale: Set<Long>): Outcome {
        val done = CompletableDeferred<Outcome>()
        inbox.trySend(ReplaceHistory(conversation, records, stale, done))
        return done.await()
    }

    /** `background_flush` (§6.2): the heads go over HTTP while there is no socket. */
    suspend fun backgroundFlush(): Outcome = dispatch(event("background_flush") {})

    /** The session ended: the model and its storage are wiped, requests and alarms of it dropped. */
    suspend fun reset() {
        val done = CompletableDeferred<Unit>()
        inbox.trySend(Reset(done))
        done.await()
    }

    // ── the queue ───────────────────────────────────────────────────────────────────────────

    private suspend fun run(command: Command) {
        when (command) {
            is Restore -> restore()
            is Dispatch -> {
                val outcome = process(command.event)
                command.done?.complete(outcome)
            }
            is ReplaceHistory -> {
                val list = current.messages[command.conversation]
                if (list != null) {
                    val pageIds = command.records.mapNotNullTo(HashSet()) { it["id"].long() }
                    val trimmed = current.deepCopy()
                    val kept = list.filter { it.id !in command.stale || it.id in pageIds }
                    if (kept.isEmpty()) trimmed.messages.remove(command.conversation)
                    else trimmed.messages[command.conversation] = kept.mapTo(ArrayList()) { it.copy() }
                    if (kept.size != list.size) markDirty(command.conversation)
                    current = trimmed
                }
                command.done.complete(process(event("history_page") { put("body", JsonArray(command.records)) }))
            }
            is Reset -> {
                work.cancel()
                work = newWork()
                epoch++
                alarms.clear()
                dirtyCache.clear()
                runCatching { store.clear() }
                current = DeliveryState()
                _state.value = current
                command.done.complete(Unit)
            }
            is FlushCache -> {
                cacheFlushScheduled = false
                if (dirtyCache.isNotEmpty()) {
                    val cache = takeDirtyCache()
                    runCatching { store.writeCache(cache) }
                }
            }
        }
    }

    private suspend fun restore() {
        val stored = runCatching { store.load() }.getOrDefault(StoredDelivery())
        current = DeliveryState(
            me = stored.me,
            sync = SyncState(cursor = stored.cursor),
            seq = stored.seq,
            outbox = stored.outbox.mapTo(ArrayList()) { it.copy() },
            ops = stored.ops.mapTo(ArrayList()) { it.copy() },
            cancelled = ArrayList(stored.cancelled)
        )
        process(event("app_restart") {})
        // The cache fills the model again (§6.3 app_restart), oldest conversation first.
        for ((_, records) in stored.cache) {
            if (records.isNotEmpty()) process(event("history_page") { put("body", JsonArray(records)) }, cacheWrite = false)
        }
        _ready.value = true
        // Started while a socket was already up (it never sends auth_success again).
        link.authenticatedUserId()?.let { id -> process(authSuccess(id)) }
    }

    private fun nextNow(): Long {
        lastNow = maxOf(lastNow, clock())
        return lastNow
    }

    private suspend fun process(event: JsonObject, cacheWrite: Boolean = true): Outcome {
        val ev = if (event.containsKey("now")) event else JsonObject(event + ("now" to JsonPrimitive(nextNow())))
        val type = ev["type"].string()
        val before = current
        val step = DeliveryReducer.reduce(before, ev)
        if (cacheWrite && type in MESSAGE_EVENTS) trackCache(before, step.state)

        val persist = step.effects.firstOrNull() as? DeliveryEffect.Persist
        if (persist != null) {
            try {
                store.persist(persist.slices, step.state, takeDirtyCache(step.state))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onPersistFailed(ev, type)
                return Outcome(false, step.effects)
            }
        } else if (dirtyCache.isNotEmpty()) {
            scheduleCacheFlush()
        }
        current = step.state
        _state.value = current
        for (effect in step.effects) execute(effect)
        return Outcome(true, step.effects)
    }

    /** §5: the new state is dropped; what happens next depends on who sent the event. */
    private fun onPersistFailed(ev: JsonObject, type: String?) {
        when (type) {
            in USER_EVENTS -> Unit // the caller shows the error; the composer keeps its text
            in SERVER_EVENTS -> link.restart() // the next sync chain returns the same data
            else -> {
                val retry = JsonObject(ev - "now")
                val session = epoch
                work.launch {
                    delay(PERSIST_RETRY_MS)
                    if (session == epoch) post(retry)
                }
            }
        }
    }

    private fun execute(effect: DeliveryEffect) {
        val session = epoch
        when (effect) {
            is DeliveryEffect.Persist, is DeliveryEffect.ClearComposer -> Unit
            is DeliveryEffect.SendWs -> {
                // A refused write means the socket is closing: treat it as gone now (its close follows).
                if (!link.send(effect.frame)) post(event("ws_disconnected") {})
            }
            is DeliveryEffect.SendHttp -> work.launch {
                val result = runCatching { backend.post(effect.path, effect.body) }.getOrElse { e ->
                    if (e is CancellationException) throw e
                    HttpOutcome(0, null)
                }
                if (session != epoch) return@launch
                post(event("http_send_result") {
                    put("client_msg_id", effect.clientMsgId)
                    put("attempt", effect.attempt)
                    put("status", result.status)
                    put("body", result.body ?: JsonNull)
                })
            }
            is DeliveryEffect.Schedule -> {
                // Identical alarms collapse; stale ones are harmless (§6.5).
                val key = "${effect.at}|${effect.event}"
                if (!alarms.add(key)) return
                work.launch {
                    delay((effect.at - clock()).coerceAtLeast(0))
                    alarms.remove(key)
                    if (session == epoch) post(effect.event)
                }
            }
            is DeliveryEffect.SyncRequest -> work.launch {
                val outcome = runCatching { backend.sync(effect.cursor, effect.limit) }.getOrElse { e ->
                    if (e is CancellationException) throw e
                    SyncOutcome.Failed(0)
                }
                if (session != epoch) return@launch
                post(
                    when (outcome) {
                        is SyncOutcome.Page -> event("sync_page") {
                            put("chain", effect.chain)
                            put("body", outcome.body)
                        }
                        is SyncOutcome.CursorInvalid -> event("sync_reset_410") {
                            put("chain", effect.chain)
                            put("body", outcome.body)
                        }
                        is SyncOutcome.Failed -> event("sync_failed") {
                            put("chain", effect.chain)
                            put("status", outcome.status)
                            outcome.retryAfterMs?.let { put("retry_after_ms", it) }
                        }
                    }
                )
            }
            is DeliveryEffect.RefreshConversationLists -> work.launch {
                val snapshot = runCatching { backend.unreadSnapshot() }.getOrNull() ?: return@launch
                if (session != epoch) return@launch
                post(event("unread_snapshot") {
                    put("counts", JsonObject(snapshot.counts.mapValues { JsonPrimitive(it.value) }))
                    if (snapshot.lastMessageIds.isNotEmpty()) {
                        put("last_message_ids", JsonObject(snapshot.lastMessageIds.mapValues { (_, v) -> v?.let(::JsonPrimitive) ?: JsonNull }))
                    }
                })
            }
            is DeliveryEffect.LoadHistory -> work.launch {
                val page = runCatching { backend.history(effect.conversation) }.getOrNull() ?: return@launch
                if (session != epoch) return@launch
                post(event("history_page") { put("body", JsonArray(page)) })
            }
            is DeliveryEffect.UserError -> _userErrors.tryEmit(effect.code)
        }
    }

    // ── conversation cache ──────────────────────────────────────────────────────────────────

    private fun trackCache(before: DeliveryState, after: DeliveryState) {
        for (conv in before.messages.keys + after.messages.keys) {
            if (before.messages[conv] != after.messages[conv]) dirtyCache += conv
        }
    }

    private fun markDirty(conversation: String) {
        dirtyCache += conversation
    }

    private fun takeDirtyCache(state: DeliveryState = current): Map<String, List<Msg>> {
        if (dirtyCache.isEmpty()) return emptyMap()
        val cache = dirtyCache.associateWith { conv -> state.messages[conv].orEmpty().takeLast(DeliveryStore.CACHE_PER_CONVERSATION).map { it.copy() } }
        dirtyCache.clear()
        return cache
    }

    private fun scheduleCacheFlush() {
        if (cacheFlushScheduled) return
        cacheFlushScheduled = true
        work.launch {
            delay(cacheDelayMs)
            inbox.trySend(FlushCache)
        }
    }

    // ── events ──────────────────────────────────────────────────────────────────────────────

    private fun frameEvent(frame: JsonObject): JsonObject =
        if (frame["type"].string() == DeliveryLink.SOCKET_CLOSED) event("ws_disconnected") {} else event("ws") { put("frame", frame) }

    private fun authSuccess(userId: Long) = event("ws") {
        put("frame", buildJsonObject {
            put("type", "auth_success")
            put("user", buildJsonObject { put("id", userId) })
        })
    }

    companion object {
        const val PERSIST_RETRY_MS = 1_000L

        private val USER_EVENTS = setOf("enqueue", "edit", "delete", "cancel", "retry")
        private val SERVER_EVENTS = setOf("ws", "sync_page", "sync_reset_410", "sync_failed", "history_page", "http_send_result", "unread_snapshot")
        private val MESSAGE_EVENTS = setOf("ws", "sync_page", "sync_reset_410", "history_page", "http_send_result")

        /** Canonical lower-case UUID v4 (§7.1). */
        fun newClientMsgId(): String = UUID.randomUUID().toString()

        fun event(type: String, fields: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject {
            put("type", type)
            fields()
        }

        /** `direct:<peer>` / `channel:<id>`. */
        fun conversationKey(isChannel: Boolean, targetId: Long): String = if (isChannel) "channel:$targetId" else "direct:$targetId"

        internal fun JsonElement?.asLong(): Long? = long()
    }
}
