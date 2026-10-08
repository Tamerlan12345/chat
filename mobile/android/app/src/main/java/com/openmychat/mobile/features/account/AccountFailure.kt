package com.openmychat.mobile.features.account

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.network.UnauthorizedException
import com.openmychat.mobile.core.session.SecureStorageUnavailableException

/**
 * Why registration, account deletion, a report or a block failed, as the screen may say it. The same
 * cases as iOS `AccountFailure`; texts are fixed client copy ([accountFailureText]). The server's own
 * text is kept only where it explains how to fix the input (validation, other conflicts, a wrong code).
 */
sealed interface AccountFailure {
    enum class Context { REGISTRATION_REQUEST, REGISTRATION_VERIFY, DELETE_ACCOUNT, GENERIC }

    enum class ConflictKind { USERNAME_TAKEN, EMAIL_TAKEN, OTHER }

    data object Offline : AccountFailure

    /** `403 REGISTRATION_DISABLED`: the administrator turned self-registration off (decision Q). */
    data object RegistrationDisabled : AccountFailure

    /** `503`: the server cannot send the confirmation e-mail (mail is not configured). */
    data object MailNotConfigured : AccountFailure

    /** `429`, or a busy server ([busy], 503 `BUSY`): wait until [untilMillis]. */
    data class Throttled(val untilMillis: Long, val busy: Boolean = false) : AccountFailure

    /** `400` while requesting a code: the server explains what to fix. */
    data class InvalidInput(val text: String) : AccountFailure

    /** `409`: the login or e-mail is taken; [text] is the server's, for [ConflictKind.OTHER]. */
    data class Conflict(val kind: ConflictKind, val text: String) : AccountFailure

    /** A wrong e-mail code; [attemptsLeft] when the server says how many tries remain. */
    data class WrongCode(val text: String, val attemptsLeft: Int?) : AccountFailure

    /** Expired, used, out of attempts or unknown: the server does not tell these apart. */
    data object CodeExpired : AccountFailure

    /** `503 EMAIL_SEND_FAILED`: mail is configured but sending failed. */
    data object MailSendFailed : AccountFailure
    data object WrongPassword : AccountFailure

    /** `400 LAST_ADMIN`: the only administrator cannot delete the account. */
    data object LastAdmin : AccountFailure

    /** The session could not be written to (or wiped from) the device's secure storage. */
    data object StorageUnavailable : AccountFailure
    data object Unavailable : AccountFailure

    /** When another attempt is allowed, for a failure that imposes a wait. */
    val retryDeadline: Long? get() = (this as? Throttled)?.untilMillis

    companion object {
        const val DEFAULT_THROTTLE_SECONDS = 60L
        const val DEFAULT_BUSY_SECONDS = 5L
        const val MESSAGE_LIMIT = 200

        private val BUSY_CODES = setOf("PASSWORD_HASH_BUSY", "LOGIN_BUSY", "BUSY")

        fun from(error: Throwable, context: Context, nowMillis: Long): AccountFailure = when (error) {
            is SecureStorageUnavailableException -> StorageUnavailable
            is UnauthorizedException -> if (context == Context.DELETE_ACCOUNT) WrongPassword else Unavailable
            is ApiException -> classify(error, context, nowMillis)
            else -> Unavailable
        }

        private fun classify(error: ApiException, context: Context, nowMillis: Long): AccountFailure {
            val status = error.statusCode
            val code = error.errorCode
            if (status == 0) return Offline
            // Decision Q: self-registration is off — at either step, whatever the status.
            if (code == "REGISTRATION_DISABLED" &&
                (context == Context.REGISTRATION_REQUEST || context == Context.REGISTRATION_VERIFY)
            ) return RegistrationDisabled
            fun throttled(defaultSeconds: Long = DEFAULT_THROTTLE_SECONDS, busy: Boolean = false) =
                Throttled(nowMillis + (error.retryAfterSeconds ?: defaultSeconds) * 1_000, busy)
            return when (context) {
                Context.REGISTRATION_REQUEST -> when (status) {
                    400, 422 -> InvalidInput(clean(error.message))
                    409 -> conflict(code, error.message)
                    429 -> throttled()
                    503 -> when (code) {
                        in BUSY_CODES -> throttled(DEFAULT_BUSY_SECONDS, busy = true)
                        "EMAIL_SEND_FAILED" -> MailSendFailed
                        else -> MailNotConfigured
                    }
                    else -> Unavailable
                }
                Context.REGISTRATION_VERIFY -> when {
                    code == "CODE_EXPIRED" -> CodeExpired
                    status in setOf(400, 401, 403, 422) -> WrongCode(clean(error.message), error.attemptsLeft)
                    status == 404 || status == 410 -> CodeExpired
                    status == 409 -> conflict(code, error.message)
                    status == 429 -> throttled()
                    else -> Unavailable
                }
                Context.DELETE_ACCOUNT -> when {
                    code == "LAST_ADMIN" -> LastAdmin
                    status in setOf(400, 401, 403) -> WrongPassword
                    status == 429 -> throttled()
                    else -> Unavailable
                }
                Context.GENERIC -> if (status == 429) throttled() else Unavailable
            }
        }

        private fun conflict(code: String?, message: String?) = Conflict(
            kind = when (code) {
                "USERNAME_TAKEN" -> ConflictKind.USERNAME_TAKEN
                "EMAIL_TAKEN" -> ConflictKind.EMAIL_TAKEN
                else -> ConflictKind.OTHER
            },
            text = clean(message)
        )

        /** Server text as one plain line, capped at [MESSAGE_LIMIT] characters. */
        fun clean(raw: String?): String {
            val collapsed = raw.orEmpty().split(Regex("""\s+""")).filter { it.isNotEmpty() }.joinToString(" ")
            return if (collapsed.length <= MESSAGE_LIMIT) collapsed else collapsed.take(MESSAGE_LIMIT - 1) + "…"
        }
    }
}

/** Whole seconds left of a wait at [nowMillis], rounded up; 0 when it is over. */
fun AccountFailure.Throttled.secondsLeft(nowMillis: Long): Long =
    ((untilMillis - nowMillis + 999) / 1_000).coerceAtLeast(0)
