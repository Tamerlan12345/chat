package com.openmychat.mobile.data.delivery

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * The client delivery model of `mobile/contracts/delivery-state.md` §3, mutable inside one reducer
 * step only: [DeliveryReducer.reduce] deep-copies its input and never changes it. [toJson] /
 * [fromJson] are the contract's projection (the vectors compare it); [Msg.record] is the platform's
 * extra — the whole server record for the screen — and is not part of the projection.
 */
class DeliveryState(
    var me: Long? = null,
    var connection: String = OFFLINE,
    var visible: String? = null,
    val sync: SyncState = SyncState(),
    var seq: Long = 0,
    var outbox: MutableList<OutboxEntry> = ArrayList(),
    var ops: MutableList<Op> = ArrayList(),
    /** Conversation key → messages by ascending id; insertion order of keys is kept (JS object order). */
    var messages: LinkedHashMap<String, MutableList<Msg>> = LinkedHashMap(),
    var unread: LinkedHashMap<String, Long> = LinkedHashMap(),
    var sendLog: MutableList<Long> = ArrayList(),
    var opsLog: MutableList<Long> = ArrayList(),
    var wakeAt: Long? = null,
    var cancelled: MutableList<String> = ArrayList()
) {
    fun deepCopy(): DeliveryState = DeliveryState(
        me = me,
        connection = connection,
        visible = visible,
        sync = sync.copy(),
        seq = seq,
        outbox = outbox.mapTo(ArrayList()) { it.copy() },
        ops = ops.mapTo(ArrayList()) { it.copy() },
        messages = LinkedHashMap<String, MutableList<Msg>>().also { copy ->
            messages.forEach { (k, list) -> copy[k] = list.mapTo(ArrayList()) { it.copy() } }
        },
        unread = LinkedHashMap(unread),
        sendLog = ArrayList(sendLog),
        opsLog = ArrayList(opsLog),
        wakeAt = wakeAt,
        cancelled = ArrayList(cancelled)
    )

    fun toJson(): JsonObject = buildJsonObject {
        put("me", me?.let(::JsonPrimitive) ?: JsonNull)
        put("connection", connection)
        put("visible", visible?.let(::JsonPrimitive) ?: JsonNull)
        put("sync", sync.toJson())
        put("seq", seq)
        put("outbox", JsonArray(outbox.map { it.toJson() }))
        put("ops", JsonArray(ops.map { it.toJson() }))
        put("messages", JsonObject(messages.mapValues { (_, list) -> JsonArray(list.map { it.toJson() }) }))
        put("unread", JsonObject(unread.mapValues { JsonPrimitive(it.value) }))
        put("sendLog", JsonArray(sendLog.map(::JsonPrimitive)))
        put("opsLog", JsonArray(opsLog.map(::JsonPrimitive)))
        put("wake_at", wakeAt?.let(::JsonPrimitive) ?: JsonNull)
        put("cancelled", JsonArray(cancelled.map(::JsonPrimitive)))
    }

    companion object {
        const val OFFLINE = "offline"
        const val ONLINE = "online"

        fun fromJson(json: JsonObject): DeliveryState = DeliveryState(
            me = json["me"].long(),
            connection = json["connection"].string() ?: OFFLINE,
            visible = json["visible"].string(),
            sync = json["sync"]?.jsonObject?.let(SyncState::fromJson) ?: SyncState(),
            seq = json["seq"].long() ?: 0,
            outbox = json["outbox"].array().mapTo(ArrayList()) { OutboxEntry.fromJson(it.jsonObject) },
            ops = json["ops"].array().mapTo(ArrayList()) { Op.fromJson(it.jsonObject) },
            messages = LinkedHashMap<String, MutableList<Msg>>().also { map ->
                (json["messages"] as? JsonObject)?.forEach { (k, v) -> map[k] = v.jsonArray.mapTo(ArrayList()) { Msg.fromJson(it.jsonObject) } }
            },
            unread = LinkedHashMap<String, Long>().also { map ->
                (json["unread"] as? JsonObject)?.forEach { (k, v) -> v.long()?.let { map[k] = it } }
            },
            sendLog = json["sendLog"].array().mapNotNullTo(ArrayList()) { it.long() },
            opsLog = json["opsLog"].array().mapNotNullTo(ArrayList()) { it.long() },
            wakeAt = json["wake_at"].long(),
            cancelled = json["cancelled"].array().mapNotNullTo(ArrayList()) { it.string() }
        )
    }
}

data class SyncState(
    var cursor: String? = null,
    var running: Boolean = false,
    var bootstrap: Boolean = false,
    var chain: Long = 0
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("cursor", cursor?.let(::JsonPrimitive) ?: JsonNull)
        put("running", running)
        put("bootstrap", bootstrap)
        put("chain", chain)
    }

    companion object {
        fun fromJson(json: JsonObject) = SyncState(
            cursor = json["cursor"].string(),
            running = json["running"].bool(),
            bootstrap = json["bootstrap"].bool(),
            chain = json["chain"].long() ?: 0
        )
    }
}

/** Why an outbox entry is `failed` (§3.1): `rejected` by the server or out of `max_attempts`. */
data class Failure(val reason: String, val code: String?, val message: String?) {
    fun toJson(): JsonObject = buildJsonObject {
        put("reason", reason)
        put("code", code?.let(::JsonPrimitive) ?: JsonNull)
        put("message", message?.let(::JsonPrimitive) ?: JsonNull)
    }

    companion object {
        const val REJECTED = "rejected"
        const val MAX_ATTEMPTS = "max_attempts"

        fun fromJson(json: JsonObject) = Failure(json["reason"].string() ?: REJECTED, json["code"].string(), json["message"].string())
    }
}

/** An outbox entry (§3.1). */
data class OutboxEntry(
    var clientMsgId: String,
    val conversation: String,
    var seq: Long,
    var text: String,
    val msgType: String = TEXT,
    val replyToId: Long? = null,
    /** `{ "file_id": 42, … }` or null. */
    val metadata: JsonElement? = null,
    var state: String = QUEUED,
    var attempts: Long = 0,
    var failures: Long = 0,
    var maybeStored: Boolean = false,
    var transport: String? = null,
    var ackDeadline: Long? = null,
    var nextAttemptAt: Long? = null,
    var failure: Failure? = null,
    var pendingEdit: String? = null,
    var pendingDelete: Boolean = false
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("client_msg_id", clientMsgId)
        put("conversation", conversation)
        put("seq", seq)
        put("text", text)
        put("msgType", msgType)
        put("reply_to_id", replyToId?.let(::JsonPrimitive) ?: JsonNull)
        put("metadata", metadata ?: JsonNull)
        put("state", state)
        put("attempts", attempts)
        put("failures", failures)
        put("maybe_stored", maybeStored)
        put("transport", transport?.let(::JsonPrimitive) ?: JsonNull)
        put("ack_deadline", ackDeadline?.let(::JsonPrimitive) ?: JsonNull)
        put("next_attempt_at", nextAttemptAt?.let(::JsonPrimitive) ?: JsonNull)
        put("failure", failure?.toJson() ?: JsonNull)
        put("pending_edit", pendingEdit?.let(::JsonPrimitive) ?: JsonNull)
        put("pending_delete", pendingDelete)
    }

    companion object {
        const val QUEUED = "queued"
        const val SENDING = "sending"
        const val FAILED = "failed"
        const val TEXT = "text"
        const val WS = "ws"
        const val HTTP = "http"

        fun fromJson(json: JsonObject) = OutboxEntry(
            clientMsgId = json["client_msg_id"].string().orEmpty(),
            conversation = json["conversation"].string().orEmpty(),
            seq = json["seq"].long() ?: 0,
            text = json["text"].string().orEmpty(),
            msgType = json["msgType"].string() ?: TEXT,
            replyToId = json["reply_to_id"].long(),
            metadata = json["metadata"]?.takeUnless { it is JsonNull },
            state = json["state"].string() ?: QUEUED,
            attempts = json["attempts"].long() ?: 0,
            failures = json["failures"].long() ?: 0,
            maybeStored = json["maybe_stored"].bool(),
            transport = json["transport"].string(),
            ackDeadline = json["ack_deadline"].long(),
            nextAttemptAt = json["next_attempt_at"].long(),
            failure = (json["failure"] as? JsonObject)?.let(Failure::fromJson),
            pendingEdit = json["pending_edit"].string(),
            pendingDelete = json["pending_delete"].bool()
        )
    }
}

/** An operation on a confirmed message or a revocation by key (§3.2). */
data class Op(
    val op: String,
    val messageId: Long?,
    val clientMsgId: String?,
    val text: String?,
    var state: String = OutboxEntry.QUEUED,
    var attempts: Long = 0,
    var failures: Long = 0,
    var ackDeadline: Long? = null,
    var nextAttemptAt: Long? = null
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("op", op)
        put("message_id", messageId?.let(::JsonPrimitive) ?: JsonNull)
        put("client_msg_id", clientMsgId?.let(::JsonPrimitive) ?: JsonNull)
        put("text", text?.let(::JsonPrimitive) ?: JsonNull)
        put("state", state)
        put("attempts", attempts)
        put("failures", failures)
        put("ack_deadline", ackDeadline?.let(::JsonPrimitive) ?: JsonNull)
        put("next_attempt_at", nextAttemptAt?.let(::JsonPrimitive) ?: JsonNull)
    }

    companion object {
        const val EDIT = "edit"
        const val DELETE = "delete"
        const val CANCEL = "cancel"

        fun fromJson(json: JsonObject) = Op(
            op = json["op"].string().orEmpty(),
            messageId = json["message_id"].long(),
            clientMsgId = json["client_msg_id"].string(),
            text = json["text"].string(),
            state = json["state"].string() ?: OutboxEntry.QUEUED,
            attempts = json["attempts"].long() ?: 0,
            failures = json["failures"].long() ?: 0,
            ackDeadline = json["ack_deadline"].long(),
            nextAttemptAt = json["next_attempt_at"].long()
        )
    }
}

/** A message in `messages` (§3.3). [record] is the whole server record the screen draws from. */
data class Msg(
    val id: Long,
    var clientMsgId: String?,
    val senderId: Long,
    var text: String,
    var type: String,
    var replyToId: Long?,
    var metadataJson: String?,
    var createdAt: String?,
    var updatedAt: String?,
    var isDeleted: Int,
    var status: String?,
    var record: JsonObject? = null
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("client_msg_id", clientMsgId?.let(::JsonPrimitive) ?: JsonNull)
        put("sender_id", senderId)
        put("text", text)
        put("type", type)
        put("reply_to_id", replyToId?.let(::JsonPrimitive) ?: JsonNull)
        put("metadata_json", metadataJson?.let(::JsonPrimitive) ?: JsonNull)
        put("created_at", createdAt?.let(::JsonPrimitive) ?: JsonNull)
        put("updated_at", updatedAt?.let(::JsonPrimitive) ?: JsonNull)
        put("is_deleted", isDeleted)
        put("status", status?.let(::JsonPrimitive) ?: JsonNull)
    }

    companion object {
        fun fromJson(json: JsonObject) = Msg(
            id = json["id"].long() ?: 0,
            clientMsgId = json["client_msg_id"].string(),
            senderId = json["sender_id"].long() ?: 0,
            text = json["text"].string().orEmpty(),
            type = json["type"].string() ?: OutboxEntry.TEXT,
            replyToId = json["reply_to_id"].long(),
            metadataJson = json["metadata_json"].string(),
            createdAt = json["created_at"].string(),
            updatedAt = json["updated_at"].string(),
            isDeleted = if (json["is_deleted"].truthy()) 1 else 0,
            status = json["status"].string(),
            record = json["record"] as? JsonObject
        )
    }
}

// ── JSON access with JavaScript's meaning (the reference reducer is JavaScript) ─────────────────

/** A JSON string's value; null for anything else (`typeof x === 'string'`). */
internal fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A JSON number that is an integer (`Number.isInteger`), as a Long; null for anything else. */
internal fun JsonElement?.long(): Long? {
    val p = this as? JsonPrimitive ?: return null
    if (p.isString || p is JsonNull) return null
    p.content.toLongOrNull()?.let { return it }
    val d = p.content.toDoubleOrNull() ?: return null
    return if (d.isFinite() && d == Math.floor(d) && Math.abs(d) < 9.007199254740992E15) d.toLong() else null
}

/** Any JSON number as a Double (NaN when it is not one). */
internal fun JsonElement?.number(): Double {
    val p = this as? JsonPrimitive ?: return Double.NaN
    if (p.isString || p is JsonNull) return Double.NaN
    return p.content.toDoubleOrNull() ?: Double.NaN
}

internal fun JsonElement?.isNullish(): Boolean = this == null || this is JsonNull

/** JavaScript truthiness of a JSON value. */
internal fun JsonElement?.truthy(): Boolean = when (val p = this) {
    null, is JsonNull -> false
    is JsonPrimitive -> when {
        p.isString -> p.content.isNotEmpty()
        p.content == "true" -> true
        p.content == "false" -> false
        else -> p.content.toDoubleOrNull()?.let { it != 0.0 && !it.isNaN() } ?: false
    }
    else -> true
}

internal fun JsonElement?.bool(): Boolean = (this as? JsonPrimitive)?.takeIf { !it.isString }?.content == "true"

internal fun JsonElement?.array(): JsonArray = (this as? JsonArray) ?: buildJsonArray { }
