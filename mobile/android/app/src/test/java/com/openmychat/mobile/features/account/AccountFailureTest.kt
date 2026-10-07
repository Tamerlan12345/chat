package com.openmychat.mobile.features.account

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.network.UnauthorizedException
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.features.account.AccountFailure.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Parity with iOS `AccountFailure` (codes from mobile/contracts/registration.md and server/src/api/index.js). */
class AccountFailureTest {

    private val now = 1_000_000L

    private fun map(error: Throwable, context: Context) = AccountFailure.from(error, context, now)

    // --- transport ---------------------------------------------------------------------------------

    @Test
    fun noConnectionAndRefusedCertificatesAreOfflineInEveryContext() {
        Context.entries.forEach { context ->
            assertEquals(AccountFailure.Offline, map(ApiException(0, "NETWORK_ERROR", "Unable to resolve host"), context))
            assertEquals(AccountFailure.Offline, map(ApiException(0, "TLS_ERROR", "untrusted"), context))
        }
    }

    @Test
    fun anythingThatIsNotAnApiErrorIsUnavailable() {
        assertEquals(AccountFailure.Unavailable, map(IllegalStateException("boom"), Context.GENERIC))
    }

    @Test
    fun aSessionThatCouldNotBeStoredSaysSo() {
        assertEquals(AccountFailure.StorageUnavailable, map(SecureStorageUnavailableException(), Context.REGISTRATION_VERIFY))
    }

    // --- registration request ------------------------------------------------------------------

    @Test
    fun requestValidationKeepsTheServersExplanationOnOneCappedLine() {
        val failure = map(ApiException(400, null, "  Логин:\n  от 3 до 64 символов  "), Context.REGISTRATION_REQUEST)
        assertEquals(AccountFailure.InvalidInput("Логин: от 3 до 64 символов"), failure)

        val long = map(ApiException(422, null, "а".repeat(500)), Context.REGISTRATION_REQUEST) as AccountFailure.InvalidInput
        assertEquals(AccountFailure.MESSAGE_LIMIT, long.text.length)
        assertEquals('…', long.text.last())
    }

    @Test
    fun takenLoginAndEmailAreTold() {
        assertEquals(
            AccountFailure.Conflict(AccountFailure.ConflictKind.USERNAME_TAKEN, "Логин занят"),
            map(ApiException(409, "USERNAME_TAKEN", "Логин занят"), Context.REGISTRATION_REQUEST)
        )
        assertEquals(
            AccountFailure.Conflict(AccountFailure.ConflictKind.EMAIL_TAKEN, "Адрес занят"),
            map(ApiException(409, "EMAIL_TAKEN", "Адрес занят"), Context.REGISTRATION_REQUEST)
        )
        assertEquals(
            AccountFailure.Conflict(AccountFailure.ConflictKind.OTHER, "Что-то другое"),
            map(ApiException(409, "SOMETHING", "Что-то другое"), Context.REGISTRATION_REQUEST)
        )
    }

    @Test
    fun rateLimitsWaitForRetryAfterOrAMinute() {
        assertEquals(
            AccountFailure.Throttled(untilMillis = now + 42_000),
            map(ApiException(429, null, "Слишком много", retryAfterSeconds = 42), Context.REGISTRATION_REQUEST)
        )
        assertEquals(
            AccountFailure.Throttled(untilMillis = now + 60_000),
            map(ApiException(429, null, "Слишком много"), Context.REGISTRATION_REQUEST)
        )
    }

    @Test
    fun mailThatIsNotConfiguredIsTheDefault503() {
        assertEquals(AccountFailure.MailNotConfigured, map(ApiException(503, null, "Отправка почты не настроена"), Context.REGISTRATION_REQUEST))
        assertEquals(AccountFailure.MailNotConfigured, map(ApiException(503, "EMAIL_NOT_CONFIGURED", "x"), Context.REGISTRATION_REQUEST))
        assertEquals(AccountFailure.MailSendFailed, map(ApiException(503, "EMAIL_SEND_FAILED", "x"), Context.REGISTRATION_REQUEST))
    }

    @Test
    fun aBusyPasswordHasherIsAShortWaitNotMissingMail() {
        listOf("PASSWORD_HASH_BUSY", "LOGIN_BUSY", "BUSY").forEach { code ->
            assertEquals(
                AccountFailure.Throttled(untilMillis = now + 5_000),
                map(ApiException(503, code, "Сервер занят"), Context.REGISTRATION_REQUEST)
            )
        }
        assertEquals(
            AccountFailure.Throttled(untilMillis = now + 3_000),
            map(ApiException(503, "BUSY", "Сервер занят", retryAfterSeconds = 3), Context.REGISTRATION_REQUEST)
        )
    }

    @Test
    fun otherRequestFailuresAreUnavailable() {
        assertEquals(AccountFailure.Unavailable, map(ApiException(500, null, "Internal"), Context.REGISTRATION_REQUEST))
    }

    // --- registration verify -------------------------------------------------------------------

    @Test
    fun aWrongCodeCarriesTheAttemptsLeft() {
        assertEquals(
            AccountFailure.WrongCode("Неверный код", attemptsLeft = 3),
            map(ApiException(400, "CODE_INVALID", "Неверный код", attemptsLeft = 3), Context.REGISTRATION_VERIFY)
        )
        assertEquals(
            AccountFailure.WrongCode("Неверный код", attemptsLeft = null),
            map(ApiException(403, null, "Неверный код"), Context.REGISTRATION_VERIFY)
        )
    }

    @Test
    fun expiredUsedOrUnknownCodesAreOneAnswer() {
        assertEquals(AccountFailure.CodeExpired, map(ApiException(410, "CODE_EXPIRED", "Истёк"), Context.REGISTRATION_VERIFY))
        assertEquals(AccountFailure.CodeExpired, map(ApiException(400, "CODE_EXPIRED", "Истёк"), Context.REGISTRATION_VERIFY))
        assertEquals(AccountFailure.CodeExpired, map(ApiException(404, null, "Нет"), Context.REGISTRATION_VERIFY))
    }

    @Test
    fun verifyRateLimitAndConflicts() {
        assertEquals(AccountFailure.Throttled(now + 60_000), map(ApiException(429, null, "x"), Context.REGISTRATION_VERIFY))
        assertEquals(
            AccountFailure.Conflict(AccountFailure.ConflictKind.USERNAME_TAKEN, "x"),
            map(ApiException(409, "USERNAME_TAKEN", "x"), Context.REGISTRATION_VERIFY)
        )
        assertEquals(AccountFailure.Unavailable, map(ApiException(500, null, "x"), Context.REGISTRATION_VERIFY))
    }

    // --- account deletion ----------------------------------------------------------------------

    @Test
    fun deletionWithTheWrongPasswordSaysSo() {
        listOf(400, 403).forEach { status ->
            assertEquals(AccountFailure.WrongPassword, map(ApiException(status, null, "Неверный пароль"), Context.DELETE_ACCOUNT))
        }
        assertEquals(AccountFailure.WrongPassword, map(UnauthorizedException(), Context.DELETE_ACCOUNT))
    }

    @Test
    fun theLastAdministratorCannotLeave() {
        assertEquals(AccountFailure.LastAdmin, map(ApiException(400, "LAST_ADMIN", "x"), Context.DELETE_ACCOUNT))
    }

    @Test
    fun deletionRateLimit() {
        assertEquals(AccountFailure.Throttled(now + 600_000), map(ApiException(429, null, "x", retryAfterSeconds = 600), Context.DELETE_ACCOUNT))
        assertEquals(AccountFailure.Unavailable, map(ApiException(503, "BUSY", "x"), Context.DELETE_ACCOUNT))
    }

    // --- reports and blocks --------------------------------------------------------------------

    @Test
    fun genericActionsOnlyDistinguishTheRateLimit() {
        assertEquals(AccountFailure.Throttled(now + 600_000), map(ApiException(429, null, "x", retryAfterSeconds = 600), Context.GENERIC))
        assertEquals(AccountFailure.Unavailable, map(ApiException(404, null, "Не найдено"), Context.GENERIC))
        assertEquals(AccountFailure.Unavailable, map(UnauthorizedException(), Context.GENERIC))
    }

    // --- waits -----------------------------------------------------------------------------------

    @Test
    fun aWaitCountsDownInWholeSecondsAndEnds() {
        val throttled = AccountFailure.Throttled(untilMillis = now + 2_500)
        assertEquals(now + 2_500, throttled.retryDeadline)
        assertEquals(3L, throttled.secondsLeft(now))
        assertEquals(1L, throttled.secondsLeft(now + 2_000))
        assertEquals(0L, throttled.secondsLeft(now + 2_500))
        assertNull(AccountFailure.WrongPassword.retryDeadline)
    }
    // --- decision Q: the administrator closed self-registration ---------------------------------

    @Test
    fun registrationClosedByTheAdministratorIsItsOwnStateAtEitherStep() {
        val refusal = ApiException(403, "REGISTRATION_DISABLED", "Регистрация сейчас закрыта. Обратитесь к администратору.")
        assertEquals(AccountFailure.RegistrationDisabled, map(refusal, Context.REGISTRATION_REQUEST))
        assertEquals("not a wrong code", AccountFailure.RegistrationDisabled, map(refusal, Context.REGISTRATION_VERIFY))
    }
}
