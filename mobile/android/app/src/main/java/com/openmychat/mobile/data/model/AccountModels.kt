package com.openmychat.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

// Self-registration, account deletion, reports and blocks (mobile/contracts/registration.md).

/** `POST /api/auth/register/request`. */
@Serializable
data class RegisterRequestBody(
    @SerialName("email") val email: String,
    @SerialName("username") val username: String,
    @SerialName("displayName") val displayName: String,
    @SerialName("password") val password: String
)

/** `202 { status: "code_sent", registrationId, expiresInSec }`. */
@Serializable
data class RegistrationChallenge(
    @SerialName("status") val status: String = "code_sent",
    @SerialName("registrationId") val registrationId: String,
    @SerialName("expiresInSec") val expiresInSec: Int = 600
)

/** `POST /api/auth/register/verify`. */
@Serializable
data class RegisterVerifyBody(
    @SerialName("registrationId") val registrationId: String,
    @SerialName("code") val code: String
)

/** The e-mail is confirmed: signed in at once (the address is allowed) or waiting for an administrator. */
sealed interface RegistrationOutcome {
    data class SignedIn(val user: User) : RegistrationOutcome
    data object Pending : RegistrationOutcome
}

/** Login answers for a registration that is not (yet) approved (`403`). */
object AccountStateCode {
    const val PENDING = "ACCOUNT_PENDING"
    const val REJECTED = "ACCOUNT_REJECTED"
}

/** `DELETE /api/users/me`. */
@Serializable
data class DeleteAccountBody(@SerialName("password") val password: String)

@Serializable
enum class ReportTargetType {
    @SerialName("message") MESSAGE,
    @SerialName("user") USER
}

/** `POST /api/reports`. */
@Serializable
data class ReportBody(
    @SerialName("targetType") val targetType: ReportTargetType,
    @SerialName("targetId") val targetId: Long,
    @SerialName("reason") val reason: String,
    @SerialName("details") val details: String? = null
)

/** `POST /api/blocks`. */
@Serializable
data class BlockBody(@SerialName("userId") val userId: Long)

/** A person on the block list; [name] is null when the server sent none. */
data class BlockedUser(val id: Long, val name: String?) {
    companion object {
        private val ID_KEYS = listOf("userId", "user_id", "blockedUserId", "blocked_user_id", "id")
        private val NAME_KEYS = listOf("displayName", "display_name", "fullName", "full_name", "username")

        /** Tolerant of the entry's shape, like iOS: an id under any known key, a name if there is one. */
        /** `GET /api/blocks`: `{ blocks: [...] }`; a bare array is accepted too. */
        fun list(answer: kotlinx.serialization.json.JsonElement): List<BlockedUser> {
            val entries = (answer as? kotlinx.serialization.json.JsonArray)
                ?: (answer as? JsonObject)?.let { it["blocks"] ?: it["users"] ?: it["blocked"] } as? kotlinx.serialization.json.JsonArray
                ?: kotlinx.serialization.json.JsonArray(emptyList())
            return entries.mapNotNull { (it as? JsonObject)?.let(::from) }
        }

        fun from(entry: JsonObject): BlockedUser? {
            val id = ID_KEYS.firstNotNullOfOrNull { (entry[it] as? JsonPrimitive)?.longOrNull } ?: return null
            val name = NAME_KEYS.firstNotNullOfOrNull { key ->
                (entry[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.takeIf { it.isNotEmpty() }
            }
            return BlockedUser(id, name)
        }
    }
}
