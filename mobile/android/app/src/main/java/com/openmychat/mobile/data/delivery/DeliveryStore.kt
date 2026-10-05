package com.openmychat.mobile.data.delivery

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Durable storage of the delivery model (delivery-state.md §5 `persist`, §6.3 `app_restart`):
 * `me`, the sync cursor, `seq`, the outbox, `ops` and the cancelled keys, plus the platform's
 * conversation cache (the last messages per conversation, for a warm start; not contract state).
 */
interface DeliveryStore {
    suspend fun load(): StoredDelivery

    /**
     * Writes [slices] of [state] (and `me`) in one transaction, with [cache] changes in the same
     * transaction. Returns only once the data is on disk; throws when it could not be written.
     */
    suspend fun persist(slices: List<String>, state: DeliveryState, cache: Map<String, List<Msg>>)

    /** Conversation cache only (no contract slice changed); an empty list drops the conversation. */
    suspend fun writeCache(cache: Map<String, List<Msg>>)

    /** Everything — the session ended. */
    suspend fun clear()

    companion object {
        /** Messages of one conversation kept for the next start. */
        const val CACHE_PER_CONVERSATION = 200
    }
}

class StoredDelivery(
    val me: Long? = null,
    val cursor: String? = null,
    val seq: Long = 0,
    val outbox: List<OutboxEntry> = emptyList(),
    val ops: List<Op> = emptyList(),
    val cancelled: List<String> = emptyList(),
    /** Conversation → server records (with this device's status), oldest first. */
    val cache: Map<String, List<JsonObject>> = emptyMap()
)

/** A file picked for sending that is not in the outbox yet: it goes up first (delivery-state.md §3.1 `metadata`). */
data class PendingUpload(
    val clientMsgId: String,
    val conversation: String,
    val createdAt: Long,
    val name: String,
    val size: Long?,
    val mimeType: String?,
    val width: Int?,
    val height: Int?,
    /** The app's private copy of the picked file (survives process death, unlike a picker grant). */
    val uri: String,
    val replyToId: Long?,
    val failed: Boolean = false,
    /** The server's reason in Russian when [failed]. */
    val error: String? = null
)

interface UploadStore {
    suspend fun all(): List<PendingUpload>
    suspend fun put(upload: PendingUpload)
    suspend fun remove(clientMsgId: String)
    suspend fun clear()
}

/**
 * The server record of a cached message as this device knows it now: the stored record with the
 * merged content (§7.9), the tombstone and this device's delivery status on top.
 */
fun Msg.toRecord(): JsonObject {
    val base = record ?: JsonObject(emptyMap())
    val merged = LinkedHashMap(base)
    toJson().forEach { (k, v) -> if (k != "status") merged[k] = v }
    if (isDeleted == 1) {
        merged["text"] = JsonPrimitive("")
        merged["file_original_name"] = kotlinx.serialization.json.JsonNull
    }
    when (status) {
        "delivered", "read" -> merged["delivery_status"] = JsonPrimitive(status)
    }
    return JsonObject(merged)
}

