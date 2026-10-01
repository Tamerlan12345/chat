package com.openmychat.mobile.data.model

import com.openmychat.mobile.data.serializer.BooleanIntSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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

    @SerialName("delivery_status")
    val deliveryStatus: DeliveryStatus? = null
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
