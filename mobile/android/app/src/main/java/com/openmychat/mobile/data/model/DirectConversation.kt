package com.openmychat.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class DirectConversation(
    @SerialName("user_id")
    val userId: Long,

    @SerialName("username")
    val username: String? = null,

    @SerialName("full_name")
    val fullName: String,

    @SerialName("avatar_url")
    val avatarUrl: String? = null,

    @SerialName("status")
    val status: UserStatus = UserStatus.OFFLINE,

    @SerialName("custom_status")
    val customStatus: String? = null,

    @SerialName("job_title")
    val jobTitle: String? = null,

    @SerialName("department_name")
    val departmentName: String? = null,

    @SerialName("uin")
    val uin: Int? = null,

    @SerialName("extension")
    val extension: String? = null,

    @SerialName("email")
    val email: String? = null,

    @SerialName("phone")
    val phone: String? = null,

    @SerialName("company")
    val company: String? = null,

    @SerialName("last_message_id")
    val lastMessageId: Long? = null,

    @SerialName("last_message_text")
    val lastMessageText: String? = null,

    @SerialName("last_message_time")
    val lastMessageTime: String? = null,

    @SerialName("last_message_sender_id")
    val lastMessageSenderId: Long? = null,

    @SerialName("last_message_type")
    val lastMessageType: MessageType? = null,

    @SerialName("unread_count")
    val unreadCount: Int = 0
)
