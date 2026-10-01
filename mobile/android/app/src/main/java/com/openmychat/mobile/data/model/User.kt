package com.openmychat.mobile.data.model

import com.openmychat.mobile.data.serializer.BooleanIntSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class UserStatus(val value: String) {
    @SerialName("online")
    ONLINE("online"),

    @SerialName("away")
    AWAY("away"),

    @SerialName("dnd")
    DND("dnd"),

    @SerialName("offline")
    OFFLINE("offline");

    companion object {
        fun fromValue(value: String?): UserStatus =
            entries.firstOrNull { it.value.equals(value, ignoreCase = true) } ?: OFFLINE
    }
}

@Serializable
data class RolePermissions(
    @SerialName("can_call")
    @Serializable(with = BooleanIntSerializer::class)
    val canCall: Boolean = false,

    @SerialName("can_upload_files")
    @Serializable(with = BooleanIntSerializer::class)
    val canUploadFiles: Boolean = true,

    @SerialName("can_create_channels")
    @Serializable(with = BooleanIntSerializer::class)
    val canCreateChannels: Boolean = false,

    @SerialName("can_edit_all_messages")
    @Serializable(with = BooleanIntSerializer::class)
    val canEditAllMessages: Boolean = false,

    @SerialName("can_delete_all_messages")
    @Serializable(with = BooleanIntSerializer::class)
    val canDeleteAllMessages: Boolean = false,

    @SerialName("can_broadcast")
    @Serializable(with = BooleanIntSerializer::class)
    val canBroadcast: Boolean = false,

    @SerialName("is_admin")
    @Serializable(with = BooleanIntSerializer::class)
    val isAdmin: Boolean = false,

    @SerialName("is_scoped_admin")
    @Serializable(with = BooleanIntSerializer::class)
    val isScopedAdmin: Boolean = false
) {
    val is_admin: Boolean get() = isAdmin
    val is_scoped_admin: Boolean get() = isScopedAdmin
}

@Serializable
data class User(
    @SerialName("id")
    val id: Long,

    @SerialName("username")
    val username: String,

    @SerialName("full_name")
    val fullName: String,

    @SerialName("email")
    val email: String? = null,

    @SerialName("phone")
    val phone: String? = null,

    @SerialName("job_title")
    val jobTitle: String? = null,

    @SerialName("department_id")
    val departmentId: Long? = null,

    @SerialName("department_name")
    val departmentName: String? = null,

    @SerialName("role_id")
    val roleId: Long? = null,

    @SerialName("role_name")
    val roleName: String? = null,

    @SerialName("permissions")
    val permissions: RolePermissions? = null,

    @SerialName("uin")
    val uin: Int? = null,

    @SerialName("extension")
    val extension: String? = null,

    @SerialName("company")
    val company: String? = null,

    @SerialName("avatar_url")
    val avatarUrl: String? = null,

    @SerialName("status")
    val status: UserStatus = UserStatus.OFFLINE,

    @SerialName("custom_status")
    val customStatus: String? = null,

    @SerialName("last_seen")
    val lastSeen: String? = null,

    @SerialName("is_active")
    @Serializable(with = BooleanIntSerializer::class)
    val isActive: Boolean = true,

    @SerialName("must_change_password")
    @Serializable(with = BooleanIntSerializer::class)
    val mustChangePassword: Boolean = false,

    @SerialName("approval_status")
    val approvalStatus: String = "approved",

    @SerialName("created_at")
    val createdAt: String = ""
)

@Serializable
data class PublicUser(
    @SerialName("id")
    val id: Long,

    @SerialName("username")
    val username: String,

    @SerialName("full_name")
    val fullName: String,

    @SerialName("department_name")
    val departmentName: String? = null,

    @SerialName("job_title")
    val jobTitle: String? = null,

    @SerialName("avatar_url")
    val avatarUrl: String? = null,

    @SerialName("status")
    val status: UserStatus = UserStatus.OFFLINE,

    @SerialName("custom_status")
    val customStatus: String? = null
)
