package com.openmychat.mobile.core.network

import com.openmychat.mobile.data.model.Announcement
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus

sealed interface WsEvent {
    // Auth & lifecycle
    data class AuthSuccess(val user: User) : WsEvent
    data class AuthError(val code: String, val message: String) : WsEvent
    data class WakeState(val targetUserId: Long?, val retryAt: Long) : WsEvent
    data class ServerDisconnect(val reason: String) : WsEvent

    // Chat messages
    /**
     * Новое сообщение. [notify] — решение сервера для этого сокета (multi-device.md §5): true —
     * показать уведомление, false — нет; null — старый сервер без поля, решает локальное правило.
     */
    data class NewMessage(val message: Message, val notify: Boolean? = null) : WsEvent

    /**
     * Переписку прочитали на другом устройстве этого сотрудника (multi-device.md §6): обнулить
     * непрочитанное и снять её уведомления. [targetId] — с точки зрения читателя (собеседник / канал).
     */
    data class ConversationRead(
        val conversationType: ConversationType,
        val targetId: Long,
        val byUserId: Long,
        val at: String,
        val messageIds: List<Long> = emptyList(),
        val lastReadId: Long? = null
    ) : WsEvent
    data class MessageStatusUpdated(
        val messageId: Long,
        val status: String,
        val userId: Long,
        val timestamp: String
    ) : WsEvent
    data class MessagesRead(val byUserId: Long, val messageIds: List<Long>) : WsEvent
    data class MessageUpdated(val messageId: Long, val text: String, val updatedAt: String) : WsEvent
    data class MessageDeleted(
        val messageId: Long,
        val conversationType: String,
        val targetId: Long
    ) : WsEvent

    // Presence & typing
    data class UserTyping(
        val userId: Long,
        val userName: String,
        val conversationType: String,
        val targetId: Long,
        val isTyping: Boolean
    ) : WsEvent
    data class UserStatusChanged(
        val userId: Long,
        val status: UserStatus,
        val customStatus: String?,
        /** Событие несёт поле customStatus (null в нём — свой статус стёрт). */
        val customStatusPresent: Boolean = true
    ) : WsEvent

    // Channels
    data class ChannelCreated(val channel: Channel) : WsEvent
    data class ChannelDeleted(val channelId: Long) : WsEvent

    // Announcements
    data class NewAnnouncement(val announcement: Announcement) : WsEvent
    data class AnnouncementAcknowledged(
        val announcementId: String,
        val userId: Long,
        val userName: String
    ) : WsEvent

    // Voice Call Signalling
    data class CallOffer(
        val targetUserId: Long,
        val senderId: Long,
        val senderName: String
    ) : WsEvent
    data class CallAnswer(
        val targetUserId: Long,
        val senderId: Long,
        val senderName: String
    ) : WsEvent
    data class CallRejected(
        val targetUserId: Long,
        val senderId: Long,
        val senderName: String,
        val reason: String?
    ) : WsEvent
    data class CallEnd(
        val targetUserId: Long,
        val senderId: Long,
        val senderName: String,
        val reason: String?
    ) : WsEvent
    data class CallDenied(val reason: String) : WsEvent
    data class CallUnavailable(val targetUserId: Long, val reason: String) : WsEvent

    // Audio Binary Relay
    data class AudioFrameReceived(val senderId: Long, val pcmSamples: ShortArray) : WsEvent {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is AudioFrameReceived) return false
            return senderId == other.senderId && pcmSamples.contentEquals(other.pcmSamples)
        }
        override fun hashCode(): Int = 31 * senderId.hashCode() + pcmSamples.contentHashCode()
    }

    // Wake Buzzer
    data class WakeRing(val fromUserId: Long, val fromName: String, val at: Long) : WsEvent
    data class WakeSent(val targetUserId: Long, val at: Long, val retryAt: Long) : WsEvent
    data class WakeError(val code: String, val message: String) : WsEvent

    // Generic error
    data class GenericError(
        val context: String?,
        val message: String,
        val originalText: String? = null,
        /** Ключ отправки, к которой относится ошибка (`send_message`), если сервер его вернул. */
        val clientMsgId: String? = null,
        /** Машинный код отказа (`DM_NOT_ALLOWED`, `NOT_CHANNEL_MEMBER`, …); у старого сервера его нет. */
        val code: String? = null
    ) : WsEvent
}
