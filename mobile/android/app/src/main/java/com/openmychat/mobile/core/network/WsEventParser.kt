package com.openmychat.mobile.core.network

import com.openmychat.mobile.data.model.Announcement
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Result of reading one server -> client WebSocket text frame. */
sealed interface WsFrame {
    /** A frame the app acts on. */
    data class Event(val event: WsEvent) : WsFrame

    /** A documented server frame this client deliberately does not act on. */
    data class Ignored(val type: String) : WsFrame

    /** A frame type this client does not know. */
    data class Unknown(val type: String) : WsFrame
}

/**
 * Turns WebSocket text frames into [WsEvent]s (contract: `mobile/contracts/ws-protocol.md`).
 * Pure: no session or socket side effects, so every recorded fixture can be checked against it.
 * Throws on malformed JSON or a frame missing its payload object.
 */
object WsEventParser {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
    }

    /** Server frames the client receives but does not use (binary PCM relay, no live roster). */
    // message_cancelled: echo of cancel_message, which Android does not send yet (the send queue maps it, Task 15).
    private val ignoredTypes = setOf("ice_candidate", "user_created", "user_updated", "message_cancelled")

    fun parse(text: String): WsFrame {
        val root = json.parseToJsonElement(text).jsonObject
        val type = root.string("type") ?: return WsFrame.Unknown("")
        if (type in ignoredTypes) return WsFrame.Ignored(type)
        val event = parseEvent(type, root) ?: return WsFrame.Unknown(type)
        return WsFrame.Event(event)
    }

    private fun parseEvent(type: String, root: JsonObject): WsEvent? = when (type) {
        "auth_success" -> WsEvent.AuthSuccess(json.decodeFromJsonElement<User>(root.required("user")))
        "auth_error" -> WsEvent.AuthError(
            code = root.string("code") ?: "UNKNOWN",
            message = root.string("message") ?: "Auth error"
        )
        "wake_state" -> WsEvent.WakeState(
            targetUserId = root.long("targetUserId"),
            retryAt = root.long("retryAt") ?: 0L
        )
        "server_disconnect" -> WsEvent.ServerDisconnect(root.string("reason") ?: "Disconnected by server")
        "new_message", "direct_message", "channel_message" ->
            WsEvent.NewMessage(json.decodeFromJsonElement<Message>(root.required("message")))
        "message_status_updated" -> WsEvent.MessageStatusUpdated(
            messageId = root.long("messageId") ?: 0L,
            status = root.string("status") ?: "delivered",
            userId = root.long("userId") ?: 0L,
            timestamp = root.string("timestamp") ?: ""
        )
        "messages_read" -> WsEvent.MessagesRead(
            byUserId = root.long("byUserId") ?: 0L,
            messageIds = root["messageIds"]?.jsonArray?.mapNotNull { it.jsonPrimitive.longOrNull } ?: emptyList()
        )
        "message_updated" -> {
            val message = root.required("message")
            WsEvent.MessageUpdated(
                messageId = message.long("id") ?: 0L,
                text = message.string("text") ?: "",
                updatedAt = message.string("updated_at") ?: ""
            )
        }
        "message_deleted" -> WsEvent.MessageDeleted(
            messageId = root.long("messageId") ?: 0L,
            conversationType = root.string("conversationType") ?: "direct",
            targetId = root.long("targetId") ?: 0L
        )
        "user_typing" -> WsEvent.UserTyping(
            userId = root.long("userId") ?: 0L,
            userName = root.string("userName") ?: "",
            conversationType = root.string("conversationType") ?: "direct",
            targetId = root.long("targetId") ?: 0L,
            isTyping = root["isTyping"]?.jsonPrimitive?.booleanOrNull ?: false
        )
        "user_status_changed" -> WsEvent.UserStatusChanged(
            userId = root.long("userId") ?: root.long("user_id") ?: 0L,
            status = UserStatus.fromValue(root.string("status")),
            customStatus = root.string("customStatus")
        )
        "channel_created" -> WsEvent.ChannelCreated(json.decodeFromJsonElement<Channel>(root.required("channel")))
        "channel_deleted" -> WsEvent.ChannelDeleted(root.long("channelId") ?: 0L)
        "new_announcement" ->
            WsEvent.NewAnnouncement(json.decodeFromJsonElement<Announcement>(root.required("announcement")))
        "announcement_acknowledged" -> WsEvent.AnnouncementAcknowledged(
            announcementId = root.string("announcementId") ?: "",
            userId = root.long("userId") ?: 0L,
            userName = root.string("userName") ?: ""
        )
        "call_offer" -> WsEvent.CallOffer(
            targetUserId = root.long("targetUserId") ?: 0L,
            senderId = root.long("senderId") ?: 0L,
            senderName = root.string("senderName") ?: "Коллега"
        )
        "call_answer" -> WsEvent.CallAnswer(
            targetUserId = root.long("targetUserId") ?: 0L,
            senderId = root.long("senderId") ?: 0L,
            senderName = root.string("senderName") ?: "Коллега"
        )
        "call_rejected" -> WsEvent.CallRejected(
            targetUserId = root.long("targetUserId") ?: 0L,
            senderId = root.long("senderId") ?: 0L,
            senderName = root.string("senderName") ?: "",
            reason = root.string("reason")
        )
        "call_end" -> WsEvent.CallEnd(
            targetUserId = root.long("targetUserId") ?: 0L,
            senderId = root.long("senderId") ?: 0L,
            senderName = root.string("senderName") ?: "",
            reason = root.string("reason")
        )
        "call_denied" -> WsEvent.CallDenied(root.string("reason") ?: "Звонок запрещен")
        "call_unavailable" -> WsEvent.CallUnavailable(
            targetUserId = root.long("targetUserId") ?: 0L,
            reason = root.string("reason") ?: "Абонент недоступен"
        )
        "wake_ring" -> WsEvent.WakeRing(
            fromUserId = root.long("fromUserId") ?: 0L,
            fromName = root.string("fromName") ?: "Коллега",
            at = root.long("at") ?: System.currentTimeMillis()
        )
        "wake_sent" -> {
            val at = root.long("at") ?: System.currentTimeMillis()
            WsEvent.WakeSent(
                targetUserId = root.long("targetUserId") ?: 0L,
                at = at,
                retryAt = root.long("retryAt") ?: (at + 60_000L)
            )
        }
        "wake_error" -> WsEvent.WakeError(
            code = root.string("code") ?: "error",
            message = root.string("message") ?: "Не удалось отправить побудку"
        )
        "error" -> WsEvent.GenericError(
            context = root.string("context"),
            message = root.string("message") ?: "Server error",
            originalText = root.string("text")
        )
        else -> null
    }

    private fun JsonObject.required(key: String): JsonObject =
        this[key]?.jsonObject ?: throw IllegalArgumentException("frame without '$key'")

    /** Null for a missing key and for JSON null (not the string "null"). */
    private fun JsonObject.string(key: String): String? {
        val primitive = this[key] as? kotlinx.serialization.json.JsonPrimitive ?: return null
        return if (primitive is kotlinx.serialization.json.JsonNull) null else primitive.content
    }

    private fun JsonObject.long(key: String): Long? =
        (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.longOrNull
}
