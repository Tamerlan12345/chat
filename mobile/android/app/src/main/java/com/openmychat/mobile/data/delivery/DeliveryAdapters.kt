package com.openmychat.mobile.data.delivery

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.net.URLEncoder

/** The app's WebSocket ([RealtimeRepository]) as the engine's link. */
class RealtimeDeliveryLink(
    private val realtime: RealtimeRepository,
    private val session: SessionRepository
) : DeliveryLink {
    override val frames: Flow<JsonObject> get() = realtime.deliveryFrames
    override fun authenticatedUserId(): Long? =
        if (realtime.connectionState.value == ConnectionState.Connected) session.currentUserId else null
    override fun send(frame: JsonObject): Boolean = realtime.sendFrame(frame)
    override fun restart() = realtime.restartLink()
}

/** `/sync`, history pages, the conversation lists and `POST /messages/...` through [ApiClient]. */
class HttpDeliveryBackend(private val api: ApiClient) : DeliveryBackend {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun sync(cursor: String?, limit: Int): SyncOutcome {
        val query = buildString {
            append("/api/sync?limit=").append(limit)
            if (cursor != null) append("&since=").append(URLEncoder.encode(cursor, "UTF-8"))
        }
        val response = api.raw("GET", query)
        val body = parse(response.body) as? JsonObject
        return when {
            response.status == 200 && body != null -> SyncOutcome.Page(body)
            response.status == 410 -> SyncOutcome.CursorInvalid(body ?: JsonObject(emptyMap()))
            response.status == 200 -> SyncOutcome.Failed(0) // unreadable page: retried like a network error
            else -> SyncOutcome.Failed(response.status, response.retryAfterSeconds?.times(1000))
        }
    }

    override suspend fun history(conversation: String): List<JsonObject> {
        val (type, id) = conversation.split(':').let { it[0] to it[1] }
        val path = if (type == "channel") "/api/messages/channels/$id?limit=$HISTORY_PAGE" else "/api/messages/direct/$id?limit=$HISTORY_PAGE"
        val response = api.raw("GET", path)
        check(response.status == 200) { "history ${response.status}" }
        return (parse(response.body) as? JsonArray)?.mapNotNull { it as? JsonObject } ?: error("history: not a list")
    }

    override suspend fun unreadSnapshot(): UnreadSnapshot {
        val counts = LinkedHashMap<String, Long>()
        val last = LinkedHashMap<String, Long?>()
        // A failure of either list skips the snapshot (the next chain asks again).
        val channels = api.raw("GET", "/api/channels")
        val direct = api.raw("GET", "/api/conversations/direct")
        check(channels.status == 200 && direct.status == 200) { "lists ${channels.status}/${direct.status}" }
        (parse(channels.body) as? JsonArray)?.forEach { element ->
            val row = element as? JsonObject ?: return@forEach
            val id = row["id"].long() ?: return@forEach
            val k = "channel:$id"
            counts[k] = row["unread_count"].long() ?: 0
            if (row.containsKey("last_message_id")) last[k] = row["last_message_id"].long()
        }
        (parse(direct.body) as? JsonArray)?.forEach { element ->
            val row = element as? JsonObject ?: return@forEach
            val id = row["user_id"].long() ?: return@forEach
            val k = "direct:$id"
            counts[k] = row["unread_count"].long() ?: 0
            if (row.containsKey("last_message_id")) last[k] = row["last_message_id"].long()
        }
        return UnreadSnapshot(counts, last)
    }

    override suspend fun post(path: String, body: JsonObject): HttpOutcome {
        val response = api.raw("POST", path, body)
        return HttpOutcome(response.status, parse(response.body))
    }

    private fun parse(text: String): JsonElement? = runCatching { json.parseToJsonElement(text) }.getOrNull()

    companion object {
        const val HISTORY_PAGE = 50
    }
}
