package com.openmychat.mobile.data.delivery

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** The authenticated WebSocket as the delivery engine sees it. */
interface DeliveryLink {
    /**
     * Every server frame as received, in order, plus [SOCKET_CLOSED] whenever a socket goes away.
     * `auth_success` is the socket becoming usable.
     */
    val frames: Flow<JsonObject>

    /** The signed-in user while a socket is authenticated right now; null otherwise. */
    fun authenticatedUserId(): Long?

    /** Writes a frame; false when the socket refused it (closed or closing). */
    fun send(frame: JsonObject): Boolean

    /** Drops the socket so it reconnects (and a new sync chain re-reads what the model lost). */
    fun restart()

    companion object {
        /** Synthetic frame type: the socket closed (any reason). */
        const val SOCKET_CLOSED = "socket_closed"
    }
}

/** HTTP the engine needs (openapi.yaml `/sync`, `/messages/...`, `/channels`, `/conversations/direct`). */
interface DeliveryBackend {
    suspend fun sync(cursor: String?, limit: Int): SyncOutcome

    /** The last page of a conversation (`direct:3`, `channel:5`), oldest first. Throws when unavailable. */
    suspend fun history(conversation: String): List<JsonObject>

    /** Unread counts (and `last_message_id` where the list has it) of every conversation. Throws when unavailable. */
    suspend fun unreadSnapshot(): UnreadSnapshot

    /** `POST` a message over HTTP; status 0 — no answer (network). */
    suspend fun post(path: String, body: JsonObject): HttpOutcome
}

sealed interface SyncOutcome {
    data class Page(val body: JsonObject) : SyncOutcome
    data class CursorInvalid(val body: JsonObject) : SyncOutcome
    data class Failed(val status: Int, val retryAfterMs: Long? = null) : SyncOutcome
}

class UnreadSnapshot(
    val counts: Map<String, Long>,
    /** Only conversations whose list entry carries `last_message_id` (G7). */
    val lastMessageIds: Map<String, Long?>
)

class HttpOutcome(val status: Int, val body: JsonElement?)
