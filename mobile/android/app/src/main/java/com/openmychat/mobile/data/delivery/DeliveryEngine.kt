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
import com.openmychat.mobile.core.network.RequestOwner
import java.util.UUID
import kotlin.coroutines.EmptyCoroutineContext

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
    private val cacheDelayMs: Long = 1_000L,
    /** Failures nobody waits for (Logcat in the app). */
    private val log: (String, Throwable?) -> Unit = { _, _ -> },
    /**
     * The account signed in right now (the session), read when the stored model is restored: it is
     * checked against that account before anything of it is shown, whoever started the engine.
     */
    private val signedInNow: () -> Long? = { null }
) {
    private val _wiped = MutableSharedFlow<Unit>(extraBufferCapacity = 4)

    /** The model and its storage were wiped (sign-out, or another account signed in). */
    val wiped: SharedFlow<Unit> = _wiped.asSharedFlow()

    /**
     * The model belongs to [userId] from now on: another account's outbox, ops and cache are wiped
     * first, so nothing of theirs is ever sent from this one.
     */
    suspend fun adopt(userId: Long) {
        val done = CompletableDeferred<Unit>()
        inbox.trySend(Adopt(userId, done))
        done.await()
    }

    /** What one event did: its effects, and whether its state reached the disk (§5 persist). */
    class Outcome(val persisted: Boolean, val effects: List<DeliveryEffect>) {
        /** `enqueue` was taken: the entry is on disk and the composer may clear (§7.4). */
        val composerCleared: Boolean get() = persisted && effects.any { it is DeliveryEffect.ClearComposer }
        val userError: String? get() = effects.filterIsInstance<DeliveryEffect.UserError>().firstOrNull()?.code
    }

    private sealed interface Command
    private class Dispatch(val event: JsonObject, val done: CompletableDeferred<Outcome>?, val stillWanted: (() -> Boolean)? = null) : Command
    private class ReplaceHistory(val conversation: String, val records: List<JsonObject>, val stale: Set<Long>, val done: CompletableDeferred<Outcome>) : Command
    private class Reset(val done: CompletableDeferred<Unit>) : Command
    private class Adopt(val userId: Long, val done: CompletableDeferred<Unit>) : Command
    private object Restore : Command
    private object RetryWipe : Command
    private object RetryClaim : Command
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

    /**
     * Fail closed: the stored model could not be read ("load"), another account's could not be
     * deleted ("wipe") or the signed-in account could not be written as the owner ("owner"). Until
     * that is repaired (retried with backoff) nothing is accepted, persisted or sent — a persist now
     * would overwrite the outbox on disk, a send could be the wrong account's, an entry would name
     * no account.
     */
    private var blocked: String? = null
    private var repairAttempts = 0

    /**
     * The account the app is signed in as (the last [adopt]); null after an explicit sign-out. A
     * load or wipe that succeeds later applies it, and an enqueue stamps the queue with it, so the
     * stored queue always names its owner.
     */
    private var signedIn: Long? = null

    /** Explicit sign-out happened: the old socket's frames (still arriving) are ignored until [adopt]. */
    private var signedOut = false

    @Volatile private var ownerStored: Long? = null

    /**
     * The account written on disk as the store's owner, or null. Nothing of an account — upload
     * rows, cache — may be written while this is not that account (AttachmentSends checks it).
     */
    val ownerOnDisk: Long? get() = ownerStored

    /**
     * Subscribes to the socket and loads the stored model. Frames that arrive meanwhile wait in order.
     * Only the first call does anything; the stored model is checked against the account signed in
     * when it is read (`signedInNow`), so it does not matter who starts the engine first.
     */
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
                    // One broken command must not stop delivery for the rest of the process, and
                    // nobody waits for it forever: every waiter learns that it failed.
                    log("delivery command failed: ${command::class.simpleName}", e)
                    when (command) {
                        is Dispatch -> command.done?.complete(Outcome(false, emptyList()))
                        is ReplaceHistory -> command.done.completeExceptionally(e)
                        is Reset -> command.done.completeExceptionally(e)
                        is Adopt -> command.done.completeExceptionally(e)
                        else -> Unit
                    }
                }
            }
        }
    }

    suspend fun awaitReady() {
        ready.first { it }
    }

    /** Processes [event] (its `now` is added) after everything queued before it; returns what it did. */
    suspend fun dispatch(event: JsonObject, stillWanted: (() -> Boolean)? = null): Outcome {
        val done = CompletableDeferred<Outcome>()
        inbox.trySend(Dispatch(event, done, stillWanted))
        return done.await()
    }

    /** Fire and forget. */
    fun post(event: JsonObject) {
        inbox.trySend(Dispatch(event, null))
    }

    // ── user actions ────────────────────────────────────────────────────────────────────────

    /**
     * `enqueue` (§6.3). [Outcome.composerCleared] — the message is on disk.
     * [owner] — the account the message is written by (the composer's signed-in account, a file's
     * account when its upload began). When stated ([ownerStated]) it is taken only while the queue is
     * that account's, in memory and on disk — checked in the command loop, after everything queued
     * before it (an account switch included); a stated null is never taken.
     */
    suspend fun enqueue(
        conversation: String,
        text: String,
        msgType: String = "text",
        replyToId: Long? = null,
        metadata: JsonObject? = null,
        clientMsgId: String = newClientMsgId(),
        owner: Long? = null,
        ownerStated: Boolean = owner != null,
        /**
         * Asked in the command loop right before the entry is taken: false, and it is not taken (a
         * file cancelled while its message waited for the engine is never sent, final review M1).
         */
        stillWanted: (() -> Boolean)? = null
    ): Outcome = dispatch(event("enqueue") {
        if (ownerStated) put(OWNER, owner?.let(::JsonPrimitive) ?: JsonNull)
        put("client_msg_id", clientMsgId)
        put("conversation", conversation)
        put("text", text)
        put("msgType", msgType)
        put("reply_to_id", replyToId?.let(::JsonPrimitive) ?: JsonNull)
        put("metadata", metadata ?: JsonNull)
    }, stillWanted)

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
            is RetryWipe -> if (blocked == "wipe" && clearStore() == null) {
                signedIn?.let { claimFor(it) }
                // A socket that came up meanwhile was refused: pick it up for its own account.
                link.authenticatedUserId()?.let { id -> if (claimFor(id) == null) process(authSuccess(id)) }
            }
            is RetryClaim -> if (blocked == "owner") {
                blocked = null
                // At a cold start nobody adopted yet: the session's account is the one to claim for.
                (signedIn ?: signedInNow())?.let { user -> if (claimFor(user) == null) pickUpSocket(user) }
            }
            is Dispatch -> {
                if (command.stillWanted?.invoke() == false) {
                    command.done?.complete(Outcome(false, emptyList()))
                    return
                }
                val enqueue = command.event["type"].string() == "enqueue"
                if (enqueue && command.event.containsKey(OWNER)) {
                    // Written by a stated account: taken only into that account's queue — never into
                    // another one (an account switch queued before it), never claimed on its behalf.
                    val stated = command.event[OWNER].long()
                    if (stated == null || blocked != null || signedOut || current.me != stated || ownerStored != stated) {
                        command.done?.complete(Outcome(false, emptyList()))
                        return
                    }
                    command.done?.complete(process(JsonObject(command.event - OWNER)))
                    return
                }
                // A new entry is always stamped with its account. When the queue names none yet (the
                // owner could not be written), the message itself tries again now: taken only once
                // the account is on disk, otherwise refused (the composer keeps the text, the screen
                // says it was not saved) while the engine keeps retrying.
                if (enqueue && !signedOut && (blocked == "owner" || (blocked == null && current.me == null))) {
                    val user = signedIn
                    if (user == null || claimFor(user) != null) {
                        command.done?.complete(Outcome(false, emptyList()))
                        return
                    }
                }
                if (blocked != null || signedOut || orphaned(command.event)) {
                    // Refused, not lost: the composer keeps the text; frames come again with the next sync.
                    // After a sign-out, or before any account is known, nothing is taken in at all.
                    command.done?.complete(Outcome(false, emptyList()))
                    return
                }
                // A socket of another account: that account never sees, nor sends, this one's data.
                authenticatedAs(command.event)?.let { user -> claimFor(user) }
                if (blocked != null || (enqueue && current.me == null)) {
                    command.done?.complete(Outcome(false, emptyList()))
                    return
                }
                val outcome = process(command.event)
                command.done?.complete(outcome)
            }
            is ReplaceHistory -> {
                check(blocked == null) { "the delivery store is unavailable ($blocked)" }
                check(!signedOut && (current.me != null || signedIn != null)) { "no account is signed in" }
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
                signedIn = null
                signedOut = true
                // Loud: the caller (sign-out) must not go on as if the messages were gone.
                wipe()?.let { throw it }
                command.done.complete(Unit)
            }
            is Adopt -> {
                // A sign-out whose delete never reached the disk, followed by an account: the sign-out
                // was called off (or another account signs in). What is on disk is read again under the
                // owner rule: the same account gets its unsent messages back, another one's are wiped.
                val signOutUndone = signedOut && blocked == "wipe"
                signedIn = command.userId
                signedOut = false
                when {
                    signOutUndone -> {
                        dropSessionWork() // the pending retry of the delete
                        blocked = null
                        repairAttempts = 0
                        restore()
                    }
                    // While the store cannot be read, the owner is checked once it can (restore).
                    blocked != "load" -> {
                        claimFor(command.userId)?.let { throw it }
                        // A socket of this account that is already up (a sign-out called off after the
                        // delete) is picked up: it never sends auth_success again.
                        pickUpSocket(command.userId)
                    }
                }
                command.done.complete(Unit)
            }
            is FlushCache -> {
                cacheFlushScheduled = false
                // The cache is written only under its owner's name.
                if (blocked == null && dirtyCache.isNotEmpty() && current.me != null && ownerStored == current.me) {
                    val cache = takeDirtyCache()
                    runCatching { store.writeCache(cache) }
                }
            }
        }
    }

    /**
     * The model is [user]'s: another account's queue — or one that names no account but holds
     * something — is wiped first; an empty model is claimed. The failure of a wipe, or null.
     */
    private suspend fun claimFor(user: Long): Exception? {
        if (current.me == user && ownerStored == user) return null
        // Anything not provably this account's — another account's, or written while no account
        // was named (queue, ops, cache, file rows) — is wiped, never claimed.
        wipe()?.let { return it }
        try {
            // On disk before anything of this account can be written there.
            store.setOwner(user)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Nothing is taken until the owner is on disk; the claim is retried.
            log("delivery store owner could not be written", e)
            blocked = "owner"
            scheduleRepair(RetryClaim)
            return e
        }
        ownerStored = user
        current = current.deepCopy().apply { this.me = user }
        _state.value = current
        return null
    }

    /** A server answer or page while no account is known (signed out, nobody adopted): dropped. */
    private fun orphaned(event: JsonObject): Boolean {
        if (current.me != null || signedIn != null) return false
        if (authenticatedAs(event) != null) return false
        return event["type"].string() in SERVER_EVENTS
    }

    /**
     * Forgets everything of the current account — in memory at once (so nothing of it can be sent),
     * then on disk. A failed delete keeps the engine blocked and retries; the caller hears of it.
     */
    private suspend fun wipe(): Exception? {
        dropSessionWork()
        dirtyCache.clear()
        current = DeliveryState()
        _state.value = current
        _wiped.tryEmit(Unit)
        return clearStore()
    }

    /** Requests, alarms and repairs of the session so far are dropped; late answers are ignored. */
    private fun dropSessionWork() {
        work.cancel()
        work = newWork()
        epoch++
        alarms.clear()
        restartScheduled = false
        diskRestarts = 0
    }

    /** A socket already authenticated as [user] while the model is not online: its auth_success. */
    private suspend fun pickUpSocket(user: Long) {
        if (blocked != null || current.connection == DeliveryState.ONLINE) return
        if (link.authenticatedUserId() == user) process(authSuccess(user))
    }

    /** Null when the store is empty now; otherwise the failure (the engine stays blocked and retries). */
    private suspend fun clearStore(): Exception? = try {
        store.clear()
        ownerStored = null
        blocked = null
        repairAttempts = 0
        // The store is empty and readable now: whatever blocked the engine (a failed load) is over.
        _ready.value = true
        null
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        log("delivery store could not be wiped", e)
        blocked = "wipe"
        scheduleRepair(RetryWipe)
        e
    }

    private fun scheduleRepair(command: Command) {
        repairAttempts++
        val wait = minOf(1_000L * (1L shl (repairAttempts - 1).coerceIn(0, 5)), 30_000L)
        work.launch {
            delay(wait)
            inbox.trySend(command)
        }
    }

    /** The user id of an `auth_success` frame event, else null. */
    private fun authenticatedAs(event: JsonObject): Long? {
        if (event["type"].string() != "ws") return null
        val frame = event["frame"] as? JsonObject ?: return null
        if (frame["type"].string() != "auth_success") return null
        return (frame["user"] as? JsonObject)?.get("id").long()
    }

    private suspend fun restore() {
        val stored = try {
            store.load()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Fail closed: an empty model now would overwrite the outbox on disk with the next persist.
            log("delivery store could not be read", e)
            blocked = "load"
            scheduleRepair(Restore)
            return
        }
        blocked = null
        repairAttempts = 0
        ownerStored = stored.me
        // The owner rule of a live auth_success applies to what was just read, before any of it is
        // shown: another account's (or nobody's) store is wiped, never replayed, sent or synced.
        val owner = signedIn ?: signedInNow() ?: link.authenticatedUserId()
        if (owner != null && stored.me != owner) {
            current = DeliveryState()
            claimFor(owner)
        } else {
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
        }
        val authenticated = link.authenticatedUserId()
        authenticated?.let { claimFor(it) }
        if (blocked != null) return
        _ready.value = true
        // Started while a socket was already up (it never sends auth_success again).
        authenticated?.let { id -> process(authSuccess(id)) }
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
                // The cache goes along only under its owner's name (`me` is written with every persist).
                val cache = takeDirtyCache(step.state).takeIf { step.state.me != null }.orEmpty()
                store.persist(persist.slices, step.state, cache)
                if (step.state.me != null) ownerStored = step.state.me
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onPersistFailed(ev, type)
                return Outcome(false, step.effects)
            }
            diskRestarts = 0
        } else if (dirtyCache.isNotEmpty()) {
            scheduleCacheFlush()
        }
        current = step.state
        _state.value = current
        for (effect in step.effects) execute(effect)
        return Outcome(true, step.effects)
    }

    /** Socket restarts for failed writes in a row (a disk that stays full); a stored event resets it. */
    private var diskRestarts = 0
    @Volatile private var restartScheduled = false

    /** §5: the new state is dropped; what happens next depends on who sent the event. */
    private fun onPersistFailed(ev: JsonObject, type: String?) {
        when (type) {
            in USER_EVENTS -> Unit // the caller shows the error; the composer keeps its text
            in SERVER_EVENTS -> restartAfterDiskFailure() // the next sync chain returns the same data
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

    /**
     * The socket restarts so the next sync returns what could not be stored — at once the first
     * time, then after a growing pause (1 s, 2 s … 30 s) while the disk keeps failing, so a full disk
     * is not a reconnect loop (parity P11; iOS does the same). One restart covers the frames that
     * failed while it waited.
     */
    private fun restartAfterDiskFailure() {
        if (restartScheduled) return
        if (diskRestarts == 0) {
            diskRestarts = 1
            link.restart()
            return
        }
        restartScheduled = true
        val wait = DeliveryReducer.backoff(diskRestarts.toLong())
        diskRestarts++
        val session = epoch
        work.launch {
            delay(wait)
            restartScheduled = false
            if (session == epoch) link.restart()
        }
    }

    private fun execute(effect: DeliveryEffect) {
        val session = epoch
        // Requests are made for the account that owns the model (final review I4): they never go
        // out under another account's token, whoever is signed in when they are sent.
        val owner = current.me?.let(::RequestOwner) ?: EmptyCoroutineContext
        when (effect) {
            is DeliveryEffect.Persist, is DeliveryEffect.ClearComposer -> Unit
            is DeliveryEffect.SendWs -> {
                // A refused write means the socket is closing: treat it as gone now (its close follows).
                if (!link.send(effect.frame)) post(event("ws_disconnected") {})
            }
            is DeliveryEffect.SendHttp -> work.launch(owner) {
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
            is DeliveryEffect.SyncRequest -> work.launch(owner) {
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
            is DeliveryEffect.RefreshConversationLists -> work.launch(owner) {
                val snapshot = runCatching { backend.unreadSnapshot() }.getOrNull() ?: return@launch
                if (session != epoch) return@launch
                post(event("unread_snapshot") {
                    put("counts", JsonObject(snapshot.counts.mapValues { JsonPrimitive(it.value) }))
                    if (snapshot.lastMessageIds.isNotEmpty()) {
                        put("last_message_ids", JsonObject(snapshot.lastMessageIds.mapValues { (_, v) -> v?.let(::JsonPrimitive) ?: JsonNull }))
                    }
                })
            }
            is DeliveryEffect.LoadHistory -> work.launch(owner) {
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

        /** The `enqueue` field naming the account it is written by (not a contract field; removed before the reducer). */
        private const val OWNER = "owner"

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
