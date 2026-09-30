package com.openmychat.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class ChannelType(val value: String) {
    @SerialName("public")
    PUBLIC("public"),

    @SerialName("private")
    PRIVATE("private"),

    @SerialName("system")
    SYSTEM("system");

    companion object {
        fun fromValue(value: String?): ChannelType =
            entries.firstOrNull { it.value.equals(value, ignoreCase = true) } ?: PUBLIC
    }
}

@Serializable
data class Channel(
    @SerialName("id")
    val id: Long,

    @SerialName("name")
    val name: String,

    @SerialName("topic")
    val topic: String? = null,

    @SerialName("type")
    val type: ChannelType = ChannelType.PUBLIC,

    @SerialName("owner_id")
    val ownerId: Long? = null,

    @SerialName("created_at")
    val createdAt: String = "",

    @SerialName("member_role")
    val memberRole: String? = null,

    @SerialName("members_count")
    val membersCount: Int = 0,

    @SerialName("unread_count")
    val unreadCount: Int = 0,

    @SerialName("last_message_text")
    val lastMessageText: String? = null,

    @SerialName("last_message_time")
    val lastMessageTime: String? = null
)

@Serializable
data class ChannelCreateRequest(
    @SerialName("name")
    val name: String,

    @SerialName("topic")
    val topic: String? = null,

    @SerialName("type")
    val type: ChannelType = ChannelType.PUBLIC,

    @SerialName("member_ids")
    val memberIds: List<Long>? = null
)
