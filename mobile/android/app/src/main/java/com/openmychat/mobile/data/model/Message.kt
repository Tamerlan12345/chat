package com.openmychat.mobile.data.model

import com.openmychat.mobile.data.serializer.BooleanIntSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

@Serializable
enum class ConversationType(val value: String) {
    @SerialName("direct")
    DIRECT("direct"),

    @SerialName("channel")
    CHANNEL("channel");

    companion object {
        fun fromValue(value: String?): ConversationType =
            entries.firstOrNull { it.value.equals(value, ignoreCase = true) } ?: DIRECT
    }
}

@Serializable
enum class MessageType(val value: String) {
    @SerialName("text")
    TEXT("text"),

    @SerialName("file")
    FILE("file"),

    @SerialName("image")
    IMAGE("image");

    companion object {
        fun fromValue(value: String?): MessageType =
            entries.firstOrNull { it.value.equals(value, ignoreCase = true) } ?: TEXT
    }
}

@Serializable
enum class DeliveryStatus(val value: String) {
    @SerialName("delivered")
    DELIVERED("delivered"),

    @SerialName("read")
    READ("read");

    companion object {
        fun fromValue(value: String?): DeliveryStatus? =
            entries.firstOrNull { it.value.equals(value, ignoreCase = true) }
    }
}

@Serializable
data class MessageMetadata(
    @SerialName("file_id")
    val fileId: Long? = null,

    @SerialName("file_name")
    val fileName: String? = null,

    @SerialName("size")
    val size: Long? = null,

    @SerialName("mime_type")
    val mimeType: String? = null,

    @SerialName("url")
    val url: String? = null,

    @SerialName("reply_text")
    val replyText: String? = null,

    @SerialName("reply_sender_name")
    val replySenderName: String? = null
)

@Serializable
data class Message(
    @SerialName("id")
    val id: Long,

    @SerialName("conversation_type")
    val conversationType: ConversationType = ConversationType.DIRECT,

    @SerialName("target_id")
    val targetId: Long,

    @SerialName("sender_id")
    val senderId: Long,

    @SerialName("text")
    val text: String,

    @SerialName("type")
    val type: MessageType = MessageType.TEXT,

    @SerialName("reply_to_id")
    val replyToId: Long? = null,

    @SerialName("metadata_json")
    val metadataJson: String? = null,

    @SerialName("metadata")
    val metadata: MessageMetadata? = null,

    @SerialName("created_at")
    val createdAt: String,

    @SerialName("updated_at")
    val updatedAt: String? = null,

    @SerialName("is_deleted")
    @Serializable(with = BooleanIntSerializer::class)
    val isDeleted: Boolean = false,

    @SerialName("sender_username")
    val senderUsername: String? = null,

    @SerialName("sender_name")
    val senderName: String = "",

    @SerialName("sender_avatar")
    val senderAvatar: String? = null,

    @SerialName("sender_department")
    val senderDepartment: String? = null,

    @SerialName("file_original_name")
    val fileOriginalName: String? = null,

    /** Размеры картинки-вложения, посчитанные сервером (null — не картинка или неизвестно). */
    @SerialName("file_width")
    val fileWidth: Int? = null,

    @SerialName("file_height")
    val fileHeight: Int? = null,

    @SerialName("delivery_status")
    val deliveryStatus: DeliveryStatus? = null,

    /** Idempotency key chosen by the sending client; null for messages sent without one. */
    @SerialName("client_msg_id")
    val clientMsgId: String? = null,

    /** Только в результатах `GET /api/messages/search`: имя канала сообщения. */
    @SerialName("channel_name")
    val channelName: String? = null,

    /** Только локально: отправка ещё не подтверждена сервером ([SendState]); у записей сервера — SENT. */
    @Transient
    val sendState: SendState = SendState.SENT,

    /** Только локально: файл, выбранный на этом устройстве, пока эхо сервера не заменило запись. */
    @Transient
    val upload: LocalUpload? = null
)

/** Состояние отправки своего сообщения на этом устройстве (delivery-state.md §3.4). */
enum class SendState {
    /** В очереди: нет связи, уйдёт само после переподключения. */
    QUEUED,

    /** Кадр ушёл, ждём эхо сервера. */
    SENDING,

    /** Не отправлено: «Повторить» / «Удалить». */
    FAILED,

    /** Подтверждено сервером (или пришло от сервера). */
    SENT
}

/** One page of `GET /api/sync`. [nextCursor] is opaque and must be sent back unchanged. */
@Serializable
data class SyncPage(
    @SerialName("messages")
    val messages: List<Message>,

    @SerialName("next_cursor")
    val nextCursor: String,

    @SerialName("has_more")
    val hasMore: Boolean
)

@Serializable
data class SendMessageRequest(
    @SerialName("conversation_type")
    val conversationType: ConversationType? = null,

    @SerialName("target_id")
    val targetId: Long? = null,

    @SerialName("recipient_id")
    val recipientId: Long? = null,

    @SerialName("channel_id")
    val channelId: Long? = null,

    @SerialName("text")
    val text: String,

    @SerialName("type")
    val type: MessageType = MessageType.TEXT,

    @SerialName("reply_to_id")
    val replyToId: Long? = null,

    @SerialName("metadata")
    val metadata: MessageMetadata? = null
)
