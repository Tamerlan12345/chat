package com.openmychat.mobile.features.people

import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Сотрудник в справочнике: только то, что показывают список, поиск и карточка. Хранится и в
 * дисковом кэше справочника (не секрет: тот же справочник видит любой вошедший сотрудник).
 */
@Serializable
data class Person(
    @SerialName("id") val id: Long,
    @SerialName("full_name") val fullName: String,
    @SerialName("username") val username: String = "",
    @SerialName("job_title") val jobTitle: String? = null,
    @SerialName("department_id") val departmentId: Long? = null,
    @SerialName("department_name") val departmentName: String? = null,
    @SerialName("extension") val extension: String? = null,
    @SerialName("phone") val phone: String? = null,
    @SerialName("email") val email: String? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
    @SerialName("status") val status: UserStatus = UserStatus.OFFLINE,
    @SerialName("custom_status") val customStatus: String? = null,
    @SerialName("last_seen") val lastSeen: String? = null,
    @SerialName("role_name") val roleName: String? = null
) {
    /** «Должность · Отдел» для второй строки, без пустых частей. */
    val subtitle: String
        get() = listOfNotNull(jobTitle?.takeIf { it.isNotBlank() }, departmentName?.takeIf { it.isNotBlank() })
            .joinToString(" · ")

    companion object {
        fun from(user: User, departmentName: String? = user.departmentName) = Person(
            id = user.id,
            fullName = user.fullName.ifBlank { user.username },
            username = user.username,
            jobTitle = user.jobTitle?.trim()?.takeIf { it.isNotEmpty() },
            departmentId = user.departmentId,
            departmentName = departmentName?.trim()?.takeIf { it.isNotEmpty() },
            extension = user.extension?.trim()?.takeIf { it.isNotEmpty() },
            phone = user.phone?.trim()?.takeIf { it.isNotEmpty() },
            email = user.email?.trim()?.takeIf { it.isNotEmpty() },
            avatarUrl = user.avatarUrl,
            status = user.status,
            customStatus = user.customStatus?.trim()?.takeIf { it.isNotEmpty() },
            lastSeen = user.lastSeen,
            roleName = user.roleName?.trim()?.takeIf { it.isNotEmpty() }
        )
    }
}

/**
 * «В сети» в справочнике — как на настольном клиенте и в счётчиках `/api/org/tree`: и `online`,
 * и `away`. «Не беспокоить» сюда не входит.
 */
val UserStatus.isReachable: Boolean
    get() = this == UserStatus.ONLINE || this == UserStatus.AWAY
