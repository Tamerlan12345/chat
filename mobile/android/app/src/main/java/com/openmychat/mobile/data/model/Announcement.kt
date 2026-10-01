package com.openmychat.mobile.data.model

import com.openmychat.mobile.data.serializer.BooleanIntSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class AnnouncementTarget(val value: String) {
    @SerialName("all")
    ALL("all"),

    @SerialName("departments")
    DEPARTMENTS("departments"),

    @SerialName("users")
    USERS("users");

    companion object {
        fun fromValue(value: String?): AnnouncementTarget =
            entries.firstOrNull { it.value.equals(value, ignoreCase = true) } ?: ALL
    }
}

@Serializable
enum class AnnouncementPriority(val value: String) {
    @SerialName("normal")
    NORMAL("normal"),

    @SerialName("urgent")
    URGENT("urgent"),

    @SerialName("critical")
    CRITICAL("critical");

    companion object {
        fun fromValue(value: String?): AnnouncementPriority =
            entries.firstOrNull { it.value.equals(value, ignoreCase = true) } ?: NORMAL
    }
}

@Serializable
data class Announcement(
    @SerialName("id")
    val id: Long,

    @SerialName("author_id")
    val authorId: Long,

    @SerialName("title")
    val title: String,

    @SerialName("content")
    val content: String,

    @SerialName("target_type")
    val targetType: AnnouncementTarget = AnnouncementTarget.ALL,

    @SerialName("priority")
    val priority: AnnouncementPriority = AnnouncementPriority.NORMAL,

    @SerialName("expires_at")
    val expiresAt: String? = null,

    @SerialName("created_at")
    val createdAt: String = "",

    @SerialName("author_name")
    val authorName: String = "",

    @SerialName("author_job_title")
    val authorJobTitle: String? = null,

    @SerialName("confirmed_at")
    val confirmedAt: String? = null,

    @SerialName("is_confirmed")
    @Serializable(with = BooleanIntSerializer::class)
    val isConfirmed: Boolean = false
)

@Serializable
data class AnnouncementAcknowledgeResponse(
    @SerialName("acknowledged")
    val acknowledged: Boolean = true,

    @SerialName("confirmed_at")
    val confirmedAt: String? = null
)
