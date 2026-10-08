package com.openmychat.mobile.data.delivery

import com.openmychat.mobile.data.delivery.DeliveryState.Companion.OFFLINE
import com.openmychat.mobile.data.delivery.DeliveryState.Companion.ONLINE
import com.openmychat.mobile.data.delivery.OutboxEntry.Companion.FAILED
import com.openmychat.mobile.data.delivery.OutboxEntry.Companion.HTTP
import com.openmychat.mobile.data.delivery.OutboxEntry.Companion.QUEUED
import com.openmychat.mobile.data.delivery.OutboxEntry.Companion.SENDING
import com.openmychat.mobile.data.delivery.OutboxEntry.Companion.WS
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset

/** Result of one step: the new state and the ordered effects. */
class Step(val state: DeliveryState, val effects: List<DeliveryEffect>)

/**
 * The client delivery reducer — `mobile/contracts/delivery-state.md`, ported line by line from the
 * reference `mobile/contracts/reference/delivery-reducer.mjs` (the vectors in
 * `fixtures/reducers/` are generated against it). Pure: no clock, no randomness, no I/O.
 *
 *   reduce(state, event) -> Step(state, effects)
 *
 * Events and server frames are the contract's JSON as is (§4); section numbers refer to the contract.
 */
object DeliveryReducer {
    val CLIENT_MSG_ID_RE = Regex("^[A-Za-z0-9_-]{1,64}$")
    val CONVERSATION_RE = Regex("^(direct|channel):[1-9][0-9]*$")
    const val MAX_TEXT_LENGTH = 16000
    const val ACK_TIMEOUT_MS = 10000L
    const val HTTP_ACK_TIMEOUT_MS = 30000L
    const val MAX_ATTEMPTS = 5L
    const val SEND_RATE_MAX = 8
    const val SEND_RATE_WINDOW_MS = 1000L
    const val OPS_RATE_MAX = 8
    const val OPS_RATE_WINDOW_MS = 1000L
    const val SYNC_PAGE_LIMIT = 200
    const val SYNC_RETRY_MS = 5000L
    val KEY_ERRORS = setOf("CLIENT_MSG_ID_CONFLICT", "INVALID_CLIENT_MSG_ID", "CANCELLED")
    const val CANCELLED_MAX = 100
    const val RATE_LIMITED_RETRY_MS = 1000L
    const val RATE_LIMITED_MAX_RETRY_MS = 30000L

    /** ECMAScript WhiteSpace + LineTerminator — exactly what the server's trim() removes (§6.1). */
    private val BLANK_RE = Regex("^[\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$")
    private val MSG_TYPES = setOf("text", "file", "image")
    private val STATUS_RANK = mapOf("sent" to 1, "delivered" to 2, "read" to 3)

    fun backoff(failures: Long): Long = minOf(1000L * (1L shl (failures - 1).toInt().coerceIn(0, 30)), 30000L)

    /** Whether [text] counts as empty for a text message (§6.1). */
    fun isBlank(text: String): Boolean = BLANK_RE.matches(text)

    /** Applies one event (§6). The input state is never changed; `persist` (when needed) comes first. */
    fun reduce(input: DeliveryState, event: JsonObject): Step {
        val state = input.deepCopy()
        val effects = ArrayList<DeliveryEffect>()
        val now = event["now"].long() ?: 0L
        handle(state, event, now, effects)
        pump(state, now, effects)

        val slices = ArrayList<String>(4)
        if (state.cancelled != input.cancelled) slices += "cancelled"
        if (state.sync.cursor != input.sync.cursor) slices += "cursor"
        if (state.ops != input.ops) slices += "ops"
        if (state.seq != input.seq || state.outbox != input.outbox) slices += "outbox"
        if (slices.isNotEmpty()) effects.add(0, DeliveryEffect.Persist(slices))
        return Step(state, effects)
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────

    private class Conv(val conversationType: String, val targetId: Long)

    private fun parseConversation(conv: String): Conv {
        val parts = conv.split(':')
        return Conv(parts[0], parts.getOrNull(1)?.toLongOrNull() ?: 0L)
    }

    /** `direct:<peer>` or `channel:<id>` of a server record (§2). */
    fun conversationOf(rec: JsonObject, me: Long?): String {
        if (rec["conversation_type"].string() == "channel") return "channel:${rec["target_id"].raw()}"
        val own = me != null && rec["sender_id"].number() == me.toDouble()
        val partner = if (own) rec["target_id"] else rec["sender_id"]
        return "direct:${partner.raw()}"
    }

    /** JavaScript template-literal text of a JSON value. */
    private fun JsonElement?.raw(): String = when (this) {
        null -> "undefined"
        is JsonNull -> "null"
        is JsonPrimitive -> if (isString) content else long()?.toString() ?: content
        else -> toString()
    }

    /** Validates text the same way for enqueue and edit; a user_error code or null. */
    private fun textError(text: JsonElement?, msgType: String?): String? {
        val value = text.string() ?: return "EMPTY_TEXT"
        if (msgType == "text" && BLANK_RE.matches(value)) return "EMPTY_TEXT"
        if (value.length > MAX_TEXT_LENGTH) return "TEXT_TOO_LONG" // UTF-16 code units
        return null
    }

    /** `Date.parse` of an ISO time; -Infinity for null, NaN when unreadable. */
    private fun instant(iso: String?): Double {
        if (iso == null) return Double.NEGATIVE_INFINITY
        val text = iso.trim()
        runCatching { return Instant.parse(text).toEpochMilli().toDouble() }
        runCatching { return OffsetDateTime.parse(text).toInstant().toEpochMilli().toDouble() }
        runCatching { return LocalDateTime.parse(text.replace(' ', 'T')).toInstant(ZoneOffset.UTC).toEpochMilli().toDouble() }
        return Double.NaN
    }

    private fun statusFromRecord(rec: JsonObject, conv: String): String {
        if (conv.startsWith("channel:")) return "sent"
        return when (rec["delivery_status"].string()) {
            "read" -> "read"
            "delivered" -> "delivered"
            else -> "sent"
        }
    }

    private fun maxStatus(a: String?, b: String?): String? =
        if ((STATUS_RANK[b] ?: 0) > (STATUS_RANK[a] ?: 0)) b else a

    /** The contract projection of a server record (§3.3); the record itself rides along for the screen. */
    fun project(rec: JsonObject, status: String?) = Msg(
        id = rec["id"].long() ?: 0L,
        clientMsgId = rec["client_msg_id"].string(),
        senderId = rec["sender_id"].long() ?: 0L,
        text = rec["text"].string() ?: "",
        type = rec["type"].string() ?: "text",
        replyToId = rec["reply_to_id"].long(),
        metadataJson = rec["metadata_json"].string(),
        createdAt = rec["created_at"].string(),
        updatedAt = rec["updated_at"].string(),
        isDeleted = if (rec["is_deleted"].truthy()) 1 else 0,
        status = status,
        record = rec
    )

    /** Copies the content fields (§7.9) of [from] into [into]. */
    private fun takeContent(into: Msg, from: Msg) {
        into.text = from.text
        into.type = from.type
        into.replyToId = from.replyToId
        into.metadataJson = from.metadataJson
        into.createdAt = from.createdAt
        into.updatedAt = from.updatedAt
        into.isDeleted = from.isDeleted
        into.record = from.record
    }

    private fun sendMessageFrame(e: OutboxEntry): JsonObject {
        val c = parseConversation(e.conversation)
        return buildJsonObject {
            put("type", "send_message")
            put("conversationType", c.conversationType)
            put("targetId", c.targetId)
            put("text", e.text)
            put("msgType", e.msgType)
            put("replyToId", e.replyToId?.let(::JsonPrimitive) ?: JsonNull)
            put("metadata", e.metadata ?: JsonNull)
            put("client_msg_id", e.clientMsgId)
        }
    }

    private fun opFrame(op: Op): JsonObject = buildJsonObject {
        when (op.op) {
            Op.EDIT -> {
                put("type", "edit_message")
                put("messageId", op.messageId?.let(::JsonPrimitive) ?: JsonNull)
                put("text", op.text?.let(::JsonPrimitive) ?: JsonNull)
            }
            Op.CANCEL -> {
                put("type", "cancel_message")
                put("client_msg_id", op.clientMsgId?.let(::JsonPrimitive) ?: JsonNull)
            }
            else -> {
                put("type", "delete_message")
                put("messageId", op.messageId?.let(::JsonPrimitive) ?: JsonNull)
            }
        }
    }

    /** Event of the op_timeout alarm: delete ops are keyed by message_id, cancel ops by client_msg_id. */
    private fun opTimeoutEvent(op: Op): JsonObject = buildJsonObject {
        put("type", "op_timeout")
        if (op.op == Op.CANCEL) put("client_msg_id", op.clientMsgId) else put("message_id", op.messageId)
        put("attempt", op.attempts)
    }

    fun markReadFrame(conv: String): JsonObject {
        val c = parseConversation(conv)
        return buildJsonObject {
            put("type", "mark_read")
            put("conversationType", c.conversationType)
            put("targetId", c.targetId)
        }
    }

    private class Found(val conv: String, val m: Msg)

    private fun findMessage(state: DeliveryState, id: Long?): Found? {
        if (id == null) return null
        for ((conv, list) in state.messages) {
            list.firstOrNull { it.id == id }?.let { return Found(conv, it) }
        }
        return null
    }

    private fun cmidInUse(state: DeliveryState, cmid: String): Boolean {
        if (state.outbox.any { it.clientMsgId == cmid }) return true
        if (cmid in state.cancelled) return true
        return state.messages.values.any { list -> list.any { it.senderId == state.me && it.clientMsgId == cmid } }
    }

    private fun sortOutbox(state: DeliveryState) = state.outbox.sortBy { it.seq }
    private fun entryOf(state: DeliveryState, cmid: String?): OutboxEntry? =
        if (cmid == null) null else state.outbox.firstOrNull { it.clientMsgId == cmid }
    private fun removeEntry(state: DeliveryState, cmid: String) {
        state.outbox = state.outbox.filterTo(ArrayList()) { it.clientMsgId != cmid }
    }
    private fun deleteOpOf(state: DeliveryState, id: Long?): Op? =
        if (id == null) null else state.ops.firstOrNull { it.op == Op.DELETE && it.messageId == id }
    private fun cancelOpOf(state: DeliveryState, cmid: String?): Op? =
        if (cmid == null) null else state.ops.firstOrNull { it.op == Op.CANCEL && it.clientMsgId == cmid }
    private fun removeOp(state: DeliveryState, op: Op) {
        state.ops = state.ops.filterTo(ArrayList()) { it !== op }
    }

    /** The edit of message id that was sent last and is not confirmed yet (§3.2): at most one per message. */
    private fun sentEditOf(state: DeliveryState, id: Long?): Op? =
        if (id == null) null else state.ops.firstOrNull { it.op == Op.EDIT && it.state == SENDING && it.messageId == id }

    private fun newOp(op: String, messageId: Long?, text: String?, cmid: String? = null) = Op(op, messageId, cmid, text)

    private fun addDeleteOp(state: DeliveryState, id: Long) {
        if (deleteOpOf(state, id) == null) state.ops.add(newOp(Op.DELETE, id, null))
    }

    private fun addCancelOp(state: DeliveryState, cmid: String) {
        if (cancelOpOf(state, cmid) == null) state.ops.add(newOp(Op.CANCEL, null, null, cmid))
    }

    /** Keys of cancelled entries dropped without proof (§7.10): bounded, oldest out first. */
    private fun rememberCancelled(state: DeliveryState, cmid: String) {
        if (cmid !in state.cancelled) state.cancelled.add(cmid)
        if (state.cancelled.size > CANCELLED_MAX) state.cancelled = ArrayList(state.cancelled.takeLast(CANCELLED_MAX))
    }

    private fun forgetCancelled(state: DeliveryState, cmid: String) {
        state.cancelled = state.cancelled.filterTo(ArrayList()) { it != cmid }
    }

    /** Once a record with the key is known the message has a server id: a delete op replaces the cancel op. */
    private fun dropCancelOp(state: DeliveryState, cmid: String) {
        cancelOpOf(state, cmid)?.let { removeOp(state, it) }
    }

    /** A tombstone confirms the delete (and makes any pending edit pointless) — §6.3. */
    private fun confirmDeleted(state: DeliveryState, id: Long) {
        state.ops = state.ops.filterTo(ArrayList()) { it.messageId != id }
    }

    // ── sync chains (§6.3, §7.11) ───────────────────────────────────────────────────────────

    private fun startSync(state: DeliveryState, effects: MutableList<DeliveryEffect>) {
        state.sync.chain += 1
        state.sync.running = true
        state.sync.bootstrap = state.sync.cursor == null
        effects += DeliveryEffect.SyncRequest(state.sync.cursor, SYNC_PAGE_LIMIT, state.sync.chain)
    }

    private fun maybeStartSync(state: DeliveryState, effects: MutableList<DeliveryEffect>) {
        if (state.connection == ONLINE && !state.sync.running) startSync(state, effects)
    }

    private fun currentChain(state: DeliveryState, ev: JsonObject): Boolean =
        state.sync.running && ev["chain"].long() == state.sync.chain

    // ── outcomes of an attempt (§6.3) ───────────────────────────────────────────────────────

    private fun reject(state: DeliveryState, e: OutboxEntry, code: String?, message: String?) {
        if (e.pendingDelete) {
            removeEntry(state, e.clientMsgId)
            return
        }
        e.state = FAILED
        e.failure = Failure(Failure.REJECTED, code, message)
        e.maybeStored = false
        e.transport = null
        e.ackDeadline = null
        e.nextAttemptAt = null
        e.pendingEdit?.let {
            e.text = it
            e.pendingEdit = null
        }
    }

    private fun attemptFailed(state: DeliveryState, e: OutboxEntry, now: Long, effects: MutableList<DeliveryEffect>) {
        e.transport = null
        e.ackDeadline = null
        if (e.pendingDelete) {
            // Never sent again (§7.10); find out via sync.
            e.state = QUEUED
            e.nextAttemptAt = null
            maybeStartSync(state, effects)
            return
        }
        e.failures += 1
        if (e.failures >= MAX_ATTEMPTS) {
            e.state = FAILED
            e.failure = Failure(Failure.MAX_ATTEMPTS, null, null)
            e.nextAttemptAt = null
        } else {
            e.state = QUEUED
            e.nextAttemptAt = now + backoff(e.failures)
        }
    }

    /** Frame dropped by the server's rate limit (§7.3): not processed; retry after the pause, budget untouched. */
    private fun attemptRateLimited(state: DeliveryState, e: OutboxEntry, now: Long, retryAfterMs: Long, effects: MutableList<DeliveryEffect>) {
        if (e.pendingDelete) {
            attemptFailed(state, e, now, effects)
            return
        }
        e.state = QUEUED
        e.transport = null
        e.ackDeadline = null
        e.nextAttemptAt = now + retryAfterMs
    }

    /** Attempt cut off by disconnect/restart/401: back to queued, budget untouched (§7.3). */
    private fun attemptInterrupted(e: OutboxEntry) {
        e.state = QUEUED
        e.transport = null
        e.ackDeadline = null
        e.nextAttemptAt = null
    }

    // ── ingest of a server record (§6.3, §7.6–7.9) ──────────────────────────────────────────

    private fun ingest(state: DeliveryState, rec: JsonObject, source: String, effects: MutableList<DeliveryEffect>) {
        val conv = conversationOf(rec, state.me)
        val own = state.me != null && rec["sender_id"].number() == state.me!!.toDouble()
        val deleted = rec["is_deleted"].truthy()
        val recId = rec["id"].long()
        var reconciled = false

        val recKey = rec["client_msg_id"].string()
        if (own && recKey != null) {
            val e = entryOf(state, recKey)
            if (e != null) {
                removeEntry(state, e.clientMsgId)
                reconciled = true
                dropCancelOp(state, e.clientMsgId) // stored: the delete op below (or the tombstone) settles it
                if (!deleted && recId != null) {
                    if (e.pendingDelete) addDeleteOp(state, recId)
                    else if (e.pendingEdit != null && e.pendingEdit != rec["text"].string()) state.ops.add(newOp(Op.EDIT, recId, e.pendingEdit))
                }
            } else if (recKey in state.cancelled) {
                // A cancelled message dropped locally without proof turned up after all (§7.10).
                forgetCancelled(state, recKey)
                dropCancelOp(state, recKey)
                if (!deleted && recId != null) addDeleteOp(state, recId)
            }
        }

        val list = state.messages[conv] ?: ArrayList()
        val existing = list.firstOrNull { it.id == recId }
        var inserted = false
        if (existing != null) {
            if (deleted) {
                takeContent(existing, project(rec, null))
            } else if (existing.isDeleted == 0 && instant(rec["updated_at"].string()) >= instant(existing.updatedAt)) {
                takeContent(existing, project(rec, null))
            }
            existing.clientMsgId = existing.clientMsgId ?: recKey
            if (own) existing.status = maxStatus(existing.status, statusFromRecord(rec, conv))
        } else if (source != "update" || reconciled) {
            list.add(project(rec, if (own) statusFromRecord(rec, conv) else null))
            list.sortBy { it.id }
            state.messages[conv] = list
            inserted = true
        }

        if (deleted) {
            if (recId != null) confirmDeleted(state, recId)
        } else {
            val sent = sentEditOf(state, recId)
            if (sent != null && sent.text == rec["text"].string()) removeOp(state, sent) // the sent edit is applied (§7.10)
        }

        if (source == "live" && inserted && !deleted) {
            if (own) {
                if (conv.startsWith("channel:")) state.unread.remove(conv)
            } else if (conv == state.visible) {
                if (state.connection == ONLINE) effects += DeliveryEffect.SendWs(markReadFrame(conv))
            } else {
                state.unread[conv] = (state.unread[conv] ?: 0L) + 1
            }
        }
    }

    // ── pump and background flush (§6.2) ────────────────────────────────────────────────────

    /** Heads of each conversation that may be sent now, in seq order. */
    private fun eligibleHeads(state: DeliveryState, now: Long, onWait: (Long) -> Unit): List<OutboxEntry> {
        val busy = state.outbox.filter { it.state == SENDING && !it.pendingDelete }.mapTo(HashSet()) { it.conversation }
        val occupied = HashSet<String>()
        val heads = ArrayList<OutboxEntry>()
        for (e in state.outbox) {
            if (e.pendingDelete || e.state == FAILED || e.conversation in occupied) continue
            occupied += e.conversation
            if (e.state != QUEUED || e.conversation in busy) continue
            val next = e.nextAttemptAt
            if (next != null && next > now) {
                onWait(next)
                continue
            }
            heads += e
        }
        return heads
    }

    private fun pump(state: DeliveryState, now: Long, effects: MutableList<DeliveryEffect>) {
        if (state.connection != ONLINE || state.sync.running) return
        state.wakeAt?.let { if (it <= now) state.wakeAt = null }
        state.sendLog = state.sendLog.filterTo(ArrayList()) { now - it < SEND_RATE_WINDOW_MS }
        state.opsLog = state.opsLog.filterTo(ArrayList()) { now - it < OPS_RATE_WINDOW_MS }

        var wakeAt: Long? = null
        val wake = { t: Long -> wakeAt = wakeAt?.let { minOf(it, t) } ?: t }

        val sentEdits = HashMap<Long?, Op>() // message_id -> edit op sent by this pump
        for (op in state.ops) {
            if (op.state != QUEUED) continue
            val next = op.nextAttemptAt
            if (next != null && next > now) {
                wake(next)
                continue
            }
            if (state.opsLog.size >= OPS_RATE_MAX) {
                wake(state.opsLog[0] + OPS_RATE_WINDOW_MS)
                continue
            }
            state.opsLog.add(now)
            op.attempts += 1
            effects += DeliveryEffect.SendWs(opFrame(op))
            if (op.op == Op.EDIT) {
                // No ack timeout: an edit is not resent on silence (§7.10); it waits for confirmation.
                op.state = SENDING
                op.ackDeadline = null
                op.nextAttemptAt = null
                sentEdits[op.messageId] = op
            } else {
                op.state = SENDING
                op.ackDeadline = now + ACK_TIMEOUT_MS
                op.nextAttemptAt = null
                effects += DeliveryEffect.Schedule(op.ackDeadline!!, opTimeoutEvent(op))
            }
        }
        // A newer sent edit supersedes the older unconfirmed one of the same message.
        state.ops = state.ops.filterTo(ArrayList()) { op ->
            !(op.op == Op.EDIT && op.state == SENDING && sentEdits.containsKey(op.messageId) && sentEdits[op.messageId] !== op)
        }

        for (e in eligibleHeads(state, now, wake)) {
            if (state.sendLog.size >= SEND_RATE_MAX) {
                wake(state.sendLog[0] + SEND_RATE_WINDOW_MS)
                continue
            }
            e.state = SENDING
            e.transport = WS
            e.attempts += 1
            e.maybeStored = true
            e.ackDeadline = now + ACK_TIMEOUT_MS
            e.nextAttemptAt = null
            state.sendLog.add(now)
            effects += DeliveryEffect.SendWs(sendMessageFrame(e))
            effects += DeliveryEffect.Schedule(e.ackDeadline!!, ackTimeoutEvent(e))
        }
        val w = wakeAt
        if (w != null && w != state.wakeAt) effects += DeliveryEffect.Schedule(w, buildJsonObject { put("type", "tick") })
        state.wakeAt = w
    }

    private fun ackTimeoutEvent(e: OutboxEntry) = buildJsonObject {
        put("type", "ack_timeout")
        put("client_msg_id", e.clientMsgId)
        put("attempt", e.attempts)
    }

    private fun backgroundFlush(state: DeliveryState, now: Long, effects: MutableList<DeliveryEffect>) {
        if (state.connection != OFFLINE) return
        for (e in eligibleHeads(state, now) { }) {
            e.state = SENDING
            e.transport = HTTP
            e.attempts += 1
            e.maybeStored = true
            e.ackDeadline = now + HTTP_ACK_TIMEOUT_MS
            e.nextAttemptAt = null
            val c = parseConversation(e.conversation)
            effects += DeliveryEffect.SendHttp(
                clientMsgId = e.clientMsgId,
                attempt = e.attempts,
                method = "POST",
                path = "/api/messages/${if (c.conversationType == "channel") "channels" else "direct"}/${c.targetId}",
                body = buildJsonObject {
                    put("text", e.text)
                    put("type", e.msgType)
                    put("reply_to_id", e.replyToId?.let(::JsonPrimitive) ?: JsonNull)
                    put("metadata", e.metadata ?: JsonNull)
                    put("client_msg_id", e.clientMsgId)
                }
            )
            effects += DeliveryEffect.Schedule(e.ackDeadline!!, ackTimeoutEvent(e))
        }
    }

    // ── sync results ────────────────────────────────────────────────────────────────────────

    private fun completeChain(state: DeliveryState, effects: MutableList<DeliveryEffect>) {
        state.sync.running = false
        effects += DeliveryEffect.RefreshConversationLists
        val visible = state.visible
        if (state.sync.bootstrap && visible != null) effects += DeliveryEffect.LoadHistory(visible)

        // Cancelled entries that are not in flight (§7.10): this chain started after their last attempt.
        val unresolved = state.outbox.filter { it.pendingDelete && it.state != SENDING }
        if (!state.sync.bootstrap) {
            for (e in unresolved) {
                removeEntry(state, e.clientMsgId)
                rememberCancelled(state, e.clientMsgId)
            }
        } else {
            val seen = HashSet<String>()
            if (visible != null) seen += visible
            for (e in unresolved) {
                if (e.conversation in seen) continue
                seen += e.conversation
                effects += DeliveryEffect.LoadHistory(e.conversation)
            }
        }
        state.sync.bootstrap = false
        if (visible != null && state.connection == ONLINE) effects += DeliveryEffect.SendWs(markReadFrame(visible))
    }

    private fun onSyncPage(state: DeliveryState, ev: JsonObject, effects: MutableList<DeliveryEffect>) {
        if (!currentChain(state, ev)) return
        val body = ev["body"] as? JsonObject ?: return
        for (rec in body["messages"].array()) ingest(state, rec.jsonObject, "sync", effects)
        val next = body["next_cursor"].string()
        state.sync.cursor = next
        if (body["has_more"].truthy()) {
            effects += DeliveryEffect.SyncRequest(next, SYNC_PAGE_LIMIT, state.sync.chain)
            return
        }
        completeChain(state, effects)
    }

    // ── user actions (§6.3, §7.10) ──────────────────────────────────────────────────────────

    private fun onEnqueue(state: DeliveryState, ev: JsonObject, effects: MutableList<DeliveryEffect>) {
        val cmid = ev["client_msg_id"].string()
        if (cmid == null || !CLIENT_MSG_ID_RE.matches(cmid)) {
            effects += DeliveryEffect.UserError("INVALID_CLIENT_MSG_ID")
            return
        }
        if (cmidInUse(state, cmid)) return
        val conversation = ev["conversation"].string()
        if (conversation == null || !CONVERSATION_RE.matches(conversation)) {
            effects += DeliveryEffect.UserError("INVALID_CONVERSATION")
            return
        }
        val msgTypeElement = ev["msgType"]
        val msgType = if (msgTypeElement.isNullish()) "text" else msgTypeElement.string()
        if (msgType == null || msgType !in MSG_TYPES) {
            effects += DeliveryEffect.UserError("INVALID_MESSAGE_TYPE")
            return
        }
        textError(ev["text"], msgType)?.let {
            effects += DeliveryEffect.UserError(it)
            return
        }

        state.seq += 1
        state.outbox.add(
            OutboxEntry(
                clientMsgId = cmid,
                conversation = conversation,
                seq = state.seq,
                text = ev["text"].string()!!,
                msgType = msgType,
                replyToId = ev["reply_to_id"].long(),
                metadata = ev["metadata"]?.takeUnless { it is JsonNull }
            )
        )
        effects += DeliveryEffect.ClearComposer(conversation)
    }

    private fun onEdit(state: DeliveryState, ev: JsonObject, effects: MutableList<DeliveryEffect>) {
        val hasCmid = !ev["client_msg_id"].isNullish()
        val hasId = !ev["message_id"].isNullish()
        if (hasCmid == hasId) {
            effects += DeliveryEffect.UserError("NOT_EDITABLE")
            return
        }

        if (hasCmid) {
            val e = entryOf(state, ev["client_msg_id"].string())
            if (e == null || e.pendingDelete || e.msgType != "text") {
                effects += DeliveryEffect.UserError("NOT_EDITABLE")
                return
            }
            textError(ev["text"], "text")?.let {
                effects += DeliveryEffect.UserError(it)
                return
            }
            val text = ev["text"].string()!!
            if (e.maybeStored) e.pendingEdit = text else e.text = text
            return
        }

        val m = findMessage(state, ev["message_id"].long())?.m
        if (m == null || m.senderId != state.me || m.isDeleted != 0 || m.type != "text" || deleteOpOf(state, m.id) != null) {
            effects += DeliveryEffect.UserError("NOT_EDITABLE")
            return
        }
        textError(ev["text"], "text")?.let {
            effects += DeliveryEffect.UserError(it)
            return
        }
        state.ops.add(newOp(Op.EDIT, m.id, ev["text"].string()))
    }

    private fun onDelete(state: DeliveryState, ev: JsonObject, effects: MutableList<DeliveryEffect>) {
        val m = findMessage(state, ev["message_id"].long())?.m
        if (m == null || m.senderId != state.me || m.isDeleted != 0) {
            effects += DeliveryEffect.UserError("NOT_DELETABLE")
            return
        }
        addDeleteOp(state, m.id)
    }

    private fun onCancel(state: DeliveryState, ev: JsonObject, effects: MutableList<DeliveryEffect>) {
        val e = entryOf(state, ev["client_msg_id"].string()) ?: return
        if (!e.maybeStored) {
            removeEntry(state, e.clientMsgId)
            return
        }
        e.pendingDelete = true
        e.pendingEdit = null
        addCancelOp(state, e.clientMsgId)
        if (e.state == FAILED) {
            e.state = QUEUED
            e.failure = null
            e.failures = 0
            e.nextAttemptAt = null
        }
        if (e.state != SENDING) maybeStartSync(state, effects)
    }

    private fun onRetry(state: DeliveryState, ev: JsonObject, effects: MutableList<DeliveryEffect>) {
        val e = entryOf(state, ev["client_msg_id"].string())
        if (e == null || e.state != FAILED) return
        if (e.failure?.code in KEY_ERRORS) {
            val fresh = ev["new_client_msg_id"].string()
            if (fresh == null || !CLIENT_MSG_ID_RE.matches(fresh) || cmidInUse(state, fresh)) {
                effects += DeliveryEffect.UserError("INVALID_CLIENT_MSG_ID")
                return
            }
            e.clientMsgId = fresh
            e.maybeStored = false
        }
        e.state = QUEUED
        e.failures = 0
        e.failure = null
        e.nextAttemptAt = null
        state.seq += 1
        e.seq = state.seq
        sortOutbox(state)
    }

    // ── server frames ───────────────────────────────────────────────────────────────────────

    /**
     * error frames (§6.3, §7.12). New signals are recognized by their fields; frames of an older
     * server (no retryable, no messageId) take the old paths.
     */
    private fun onError(state: DeliveryState, frame: JsonObject, now: Long, effects: MutableList<DeliveryEffect>) {
        val rateLimited = frame["code"].string() == "RATE_LIMITED"
        val retryAfterRaw = frame["retry_after_ms"].long()
        val retryAfter = if (retryAfterRaw != null && retryAfterRaw > 0) minOf(retryAfterRaw, RATE_LIMITED_MAX_RETRY_MS) else RATE_LIMITED_RETRY_MS
        val retryable = frame["retryable"].let { it is JsonPrimitive && !it.isString && it.content == "true" }
        val messageId = frame["messageId"].long()
        when (frame["context"].string()) {
            "send_message" -> {
                if (frame["client_msg_id"].isNullish()) return
                val e = entryOf(state, frame["client_msg_id"].string())
                if (e == null || e.state == FAILED) return
                if (rateLimited || retryable) {
                    // Not a refusal: the frame was dropped or failed before storage. Only the live WS attempt.
                    if (e.state != SENDING || e.transport != WS) return
                    if (rateLimited) attemptRateLimited(state, e, now, retryAfter, effects) else attemptFailed(state, e, now, effects)
                    return
                }
                reject(state, e, frame["code"].string(), frame["message"].string())
            }
            "delete_message" -> {
                if (messageId == null) return
                val op = deleteOpOf(state, messageId)
                if (op == null || op.state != SENDING) return
                if (rateLimited) {
                    op.state = QUEUED
                    op.ackDeadline = null
                    op.nextAttemptAt = now + retryAfter
                } else if (retryable) {
                    opFailed(state, op, now, effects)
                } else {
                    removeOp(state, op)
                    effects += DeliveryEffect.UserError("DELETE_REJECTED")
                }
            }
            "edit_message" -> {
                if (messageId == null) return
                // Only the last sent edit of the message is matched; an older one was already superseded.
                val sent = sentEditOf(state, messageId)
                val own = if (sent != null && sent.text == frame["text"].string()) sent else null
                if (rateLimited) {
                    // Dropped unprocessed: send it again after the pause, unless a newer edit or a delete is
                    // pending. A stale edit (no match) is never re-queued — it would revert the newer one.
                    if (own == null) return
                    val newer = state.ops.any { o -> o.messageId == messageId && (o.op == Op.DELETE || (o.op == Op.EDIT && o.state == QUEUED)) }
                    if (newer) {
                        removeOp(state, own)
                        return
                    }
                    own.state = QUEUED
                    own.nextAttemptAt = now + retryAfter
                    return
                }
                if (own != null) removeOp(state, own)
                effects += DeliveryEffect.UserError("EDIT_REJECTED")
            }
            "cancel_message" -> {
                val cmid = frame["client_msg_id"].string() ?: return
                val op = cancelOpOf(state, cmid)
                if (op == null || op.state != SENDING) return
                if (rateLimited) {
                    op.state = QUEUED
                    op.ackDeadline = null
                    op.nextAttemptAt = now + retryAfter
                } else if (retryable) {
                    opFailed(state, op, now, effects)
                } else {
                    removeOp(state, op)
                    if (messageId != null) {
                        // Stored and cannot be deleted any more: stop hiding it, tell the user, show it again.
                        val e = entryOf(state, cmid)
                        forgetCancelled(state, cmid)
                        deleteOpOf(state, messageId)?.let { removeOp(state, it) }
                        if (e != null && e.pendingDelete) {
                            removeEntry(state, e.clientMsgId)
                            effects += DeliveryEffect.LoadHistory(e.conversation)
                        }
                        effects += DeliveryEffect.UserError("DELETE_REJECTED")
                    }
                }
            }
            else -> Unit
        }
    }

    /** message_cancelled (§7.10): the server will never store this key; a stored copy is deleted. */
    private fun onCancelled(state: DeliveryState, frame: JsonObject) {
        val cmid = frame["client_msg_id"].string() ?: return
        cancelOpOf(state, cmid)?.let { removeOp(state, it) }
        forgetCancelled(state, cmid)
        val e = entryOf(state, cmid)
        if (e != null && e.pendingDelete) removeEntry(state, cmid)
        frame["messageId"].long()?.let { confirmDeleted(state, it) }
    }

    private fun onFrame(state: DeliveryState, frame: JsonObject, now: Long, effects: MutableList<DeliveryEffect>) {
        when (frame["type"].string()) {
            "auth_success" -> {
                state.me = (frame["user"] as? JsonObject)?.get("id").let { it.long() ?: it.string()?.toLongOrNull() }
                state.connection = ONLINE
                state.sendLog = ArrayList()
                state.opsLog = ArrayList()
                if (!state.sync.running) startSync(state, effects)
            }
            "new_message", "direct_message", "channel_message" ->
                (frame["message"] as? JsonObject)?.let { ingest(state, it, "live", effects) }
            "message_updated" -> (frame["message"] as? JsonObject)?.let { ingest(state, it, "update", effects) }
            "message_deleted" -> {
                val id = frame["messageId"].long()
                findMessage(state, id)?.m?.let { m ->
                    m.isDeleted = 1
                    m.text = ""
                    m.metadataJson = null
                    frame["updated_at"].string()?.let { m.updatedAt = it }
                }
                if (id != null) confirmDeleted(state, id)
            }
            "message_cancelled" -> onCancelled(state, frame)
            "message_status_updated" -> {
                val found = findMessage(state, frame["messageId"].long())
                val status = frame["status"].string()
                if (found != null && found.conv.startsWith("direct:") && found.m.senderId == state.me && (STATUS_RANK[status] ?: 0) >= 2) {
                    found.m.status = maxStatus(found.m.status, status)
                }
            }
            "messages_read" -> {
                val list = state.messages["direct:${frame["byUserId"].raw()}"] ?: emptyList()
                for (idElement in frame["messageIds"].array()) {
                    val id = idElement.long() ?: continue
                    val m = list.firstOrNull { it.id == id }
                    if (m != null && m.senderId == state.me) m.status = "read"
                }
            }
            "error" -> onError(state, frame, now, effects)
            else -> Unit
        }
    }

    private fun onHttpSendResult(state: DeliveryState, ev: JsonObject, now: Long, effects: MutableList<DeliveryEffect>) {
        val status = ev["status"].long()
        val body = ev["body"] as? JsonObject
        if (status == 200L || status == 201L) {
            body?.let { ingest(state, it, "http", effects) }
            return
        }
        val e = entryOf(state, ev["client_msg_id"].string())
        if (e == null || e.state != SENDING || e.transport != HTTP || e.attempts != ev["attempt"].long()) return
        val s = status ?: 0L
        when {
            s == 401L -> attemptInterrupted(e)
            s in 400L..499L && s != 408L && s != 429L -> reject(state, e, body?.get("code").string(), body?.get("error").string())
            else -> attemptFailed(state, e, now, effects)
        }
    }

    /**
     * A delete/cancel op attempt failed (timeout or a retryable error): pause or give up (§7.3, §7.10).
     * A cancel op gives up silently: an older server ignores cancel_message, the sync path decides.
     */
    private fun opFailed(state: DeliveryState, op: Op, now: Long, effects: MutableList<DeliveryEffect>) {
        op.failures += 1
        op.ackDeadline = null
        if (op.failures >= MAX_ATTEMPTS) {
            removeOp(state, op)
            if (op.op == Op.DELETE) effects += DeliveryEffect.UserError("DELETE_NOT_CONFIRMED")
        } else {
            op.state = QUEUED
            op.nextAttemptAt = now + backoff(op.failures)
        }
    }

    private fun onOpTimeout(state: DeliveryState, ev: JsonObject, now: Long, effects: MutableList<DeliveryEffect>) {
        val op = if (!ev["client_msg_id"].isNullish()) cancelOpOf(state, ev["client_msg_id"].string()) else deleteOpOf(state, ev["message_id"].long())
        if (op == null || op.state != SENDING || op.attempts != ev["attempt"].long() || now < (op.ackDeadline ?: 0L)) return
        opFailed(state, op, now, effects)
    }

    /**
     * unread_snapshot counts, completed with live messages newer than the snapshot (§7.8, G7):
     * last_message_ids[k] is the newest id the server saw when it computed counts[k].
     */
    private fun snapshotTotals(state: DeliveryState, ev: JsonObject): LinkedHashMap<String, Long> {
        val lastIds = ev["last_message_ids"] as? JsonObject ?: JsonObject(emptyMap())
        val totals = LinkedHashMap<String, Long>()
        val counts = ev["counts"] as? JsonObject ?: return totals
        for ((k, nElement) in counts) {
            val n = nElement.long() ?: 0L
            if (!lastIds.containsKey(k)) {
                totals[k] = n
                continue
            }
            val list = state.messages[k] ?: emptyList()
            var base = n
            var from = lastIds[k].long() ?: 0L
            if (k.startsWith("channel:")) {
                // An own channel message newer than the snapshot read the channel up to it (§7.8).
                val ownNewer = list.filter { it.senderId == state.me && it.id > from }
                if (ownNewer.isNotEmpty()) {
                    base = 0
                    from = ownNewer.maxOf { it.id }
                }
            }
            // A tombstone has nothing to read: deleted foreign messages newer than the snapshot are not added.
            totals[k] = base + list.count { it.senderId != state.me && it.id > from && it.isDeleted == 0 }
        }
        return totals
    }

    private fun resetInFlight(state: DeliveryState, http: Boolean) {
        for (e in state.outbox) {
            if (e.state == SENDING && (http || e.transport == WS)) attemptInterrupted(e)
        }
        // An unconfirmed sent edit is not resent after a disconnect or restart (§7.10): dropped.
        state.ops = state.ops.filterTo(ArrayList()) { !(it.op == Op.EDIT && it.state == SENDING) }
        for (op in state.ops) {
            if (op.state == SENDING) {
                op.state = QUEUED
                op.ackDeadline = null
                op.nextAttemptAt = null
            }
        }
    }

    // ── reducer ─────────────────────────────────────────────────────────────────────────────

    private fun handle(state: DeliveryState, ev: JsonObject, now: Long, effects: MutableList<DeliveryEffect>) {
        when (ev["type"].string()) {
            "ws" -> (ev["frame"] as? JsonObject)?.let { onFrame(state, it, now, effects) }
            "ws_disconnected" -> {
                state.connection = OFFLINE
                state.sync.running = false
                state.sendLog = ArrayList()
                state.opsLog = ArrayList()
                resetInFlight(state, http = false)
            }
            "enqueue" -> onEnqueue(state, ev, effects)
            "edit" -> onEdit(state, ev, effects)
            "delete" -> onDelete(state, ev, effects)
            "cancel" -> onCancel(state, ev, effects)
            "retry" -> onRetry(state, ev, effects)
            "ack_timeout" -> {
                val e = entryOf(state, ev["client_msg_id"].string())
                if (e != null && e.state == SENDING && e.attempts == ev["attempt"].long() && now >= (e.ackDeadline ?: 0L)) {
                    attemptFailed(state, e, now, effects)
                }
            }
            "op_timeout" -> onOpTimeout(state, ev, now, effects)
            "tick" -> Unit
            "sync_start" -> maybeStartSync(state, effects)
            "sync_page" -> onSyncPage(state, ev, effects)
            "sync_reset_410" -> {
                if (!currentChain(state, ev)) return
                state.sync.cursor = null
                state.sync.bootstrap = true
                state.messages = LinkedHashMap()
                effects += DeliveryEffect.SyncRequest(null, SYNC_PAGE_LIMIT, state.sync.chain)
            }
            "sync_failed" -> {
                if (!currentChain(state, ev)) return
                state.sync.running = false
                if (ev["status"].long() != 401L) {
                    val retry = ev["retry_after_ms"].let { if (it.isNullish()) SYNC_RETRY_MS else it.long() ?: SYNC_RETRY_MS }
                    effects += DeliveryEffect.Schedule(now + retry, buildJsonObject { put("type", "sync_start") })
                }
            }
            "history_page" -> for (rec in ev["body"].array()) ingest(state, rec.jsonObject, "history", effects)
            "http_send_result" -> onHttpSendResult(state, ev, now, effects)
            "unread_snapshot" -> {
                val totals = snapshotTotals(state, ev)
                state.unread = LinkedHashMap()
                for ((k, n) in totals) if (n > 0 && k != state.visible) state.unread[k] = n
                val visible = state.visible
                if (visible != null && (totals[visible] ?: 0L) > 0 && state.connection == ONLINE) {
                    effects += DeliveryEffect.SendWs(markReadFrame(visible))
                }
            }
            "conversation_opened" -> {
                val conv = ev["conversation"].string() ?: return
                state.visible = conv
                state.unread.remove(conv)
                if (state.connection == ONLINE) effects += DeliveryEffect.SendWs(markReadFrame(conv))
            }
            "conversation_closed" -> state.visible = null
            "background_flush" -> backgroundFlush(state, now, effects)
            "app_restart" -> {
                state.connection = OFFLINE
                state.visible = null
                state.sync.running = false
                state.sync.bootstrap = false
                state.messages = LinkedHashMap()
                state.unread = LinkedHashMap()
                state.sendLog = ArrayList()
                state.opsLog = ArrayList()
                state.wakeAt = null
                resetInFlight(state, http = true)
            }
            else -> Unit
        }
    }
}
