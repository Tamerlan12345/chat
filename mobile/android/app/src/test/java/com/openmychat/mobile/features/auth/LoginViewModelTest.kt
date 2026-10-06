package com.openmychat.mobile.features.auth

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.network.UnauthorizedException
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.data.repository.LoginResult
import com.openmychat.mobile.testing.FakeAuthRepository
import com.openmychat.mobile.testing.FakeLoginPreferences
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class LoginViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @get:Rule
    val mainDispatcher = MainDispatcherRule(dispatcher)

    private val auth = FakeAuthRepository()
    private val preferences = FakeLoginPreferences()

    private fun viewModel() = LoginViewModel(auth, preferences)

    private fun LoginViewModel.fillAndSubmit(username: String = "alice", password: String = "Secret-1") {
        onUsernameChange(username)
        onPasswordChange(password)
        submit()
    }

    // --- submittable -----------------------------------------------------------------------------

    @Test
    fun aWhitespaceOnlyPasswordDoesNotEnableSignIn() = runTest(dispatcher) {
        val vm = viewModel()
        vm.onUsernameChange("alice")
        vm.onPasswordChange("   ")
        runCurrent()

        assertFalse("the button and the submit guard share one predicate", vm.canSubmit.value)
        vm.submit()
        runCurrent()
        assertEquals(emptyList<Pair<String, String>>(), auth.loginAttempts)

        vm.onPasswordChange(" Secret-1 ")
        runCurrent()
        assertTrue(vm.canSubmit.value)
    }

    // --- error mapping -------------------------------------------------------------------------

    @Test
    fun wrongPasswordAndUnknownLoginLookTheSame() = runTest(dispatcher) {
        // The server answers 400 for both; its text may differ and must never reach the screen.
        listOf(
            ApiException(400, null, "Пользователь bob не найден"),
            ApiException(400, "INVALID_CREDENTIALS", "Неверный пароль"),
            UnauthorizedException("Недействительный токен")
        ).forEach { failure ->
            auth.onLogin = { _, _ -> throw failure }
            val vm = viewModel()

            vm.fillAndSubmit()
            runCurrent()

            assertEquals(LoginUiState.Error(LoginError.InvalidCredentials), vm.uiState.value)
        }
    }

    @Test
    fun accountThrottlingCountsDownFromRetryAfterAndNeverRetriesByItself() = runTest(dispatcher) {
        auth.onLogin = { _, _ -> throw ApiException(429, "ACCOUNT_THROTTLED", "Слишком много попыток", retryAfterSeconds = 30) }
        val vm = viewModel()

        vm.fillAndSubmit()
        runCurrent()

        assertEquals(LoginUiState.Error(LoginError.Throttled), vm.uiState.value)
        assertEquals(30L, vm.retryAfterSeconds.value)
        assertFalse(vm.canSubmit.value)

        advanceTimeBy(1_001)
        assertEquals(29L, vm.retryAfterSeconds.value)

        vm.submit() // ignored while the countdown runs
        runCurrent()
        assertEquals(1, auth.loginAttempts.size)

        advanceTimeBy(29_001)
        assertEquals(0L, vm.retryAfterSeconds.value)
        assertTrue(vm.canSubmit.value)
        assertEquals("no automatic retry", 1, auth.loginAttempts.size)
    }

    @Test
    fun throttlingWithoutRetryAfterWaitsAMinute() = runTest(dispatcher) {
        auth.onLogin = { _, _ -> throw ApiException(429, null, "Слишком много неудачных попыток") }
        val vm = viewModel()

        vm.fillAndSubmit()
        runCurrent()

        assertEquals(LoginUiState.Error(LoginError.Throttled), vm.uiState.value)
        assertEquals(60L, vm.retryAfterSeconds.value)
    }

    @Test
    fun busyServerCountsDownBeforeTheNextAttempt() = runTest(dispatcher) {
        auth.onLogin = { _, _ -> throw ApiException(503, "LOGIN_BUSY", "Сервер занят", retryAfterSeconds = 4) }
        val vm = viewModel()

        vm.fillAndSubmit()
        runCurrent()

        assertEquals(LoginUiState.Error(LoginError.ServerBusy), vm.uiState.value)
        assertEquals(4L, vm.retryAfterSeconds.value)
        assertFalse(vm.canSubmit.value)
        advanceTimeBy(4_001)
        assertTrue(vm.canSubmit.value)
    }

    @Test
    fun networkTlsStorageAndUnexpectedFailuresHaveTheirOwnErrors() = runTest(dispatcher) {
        mapOf(
            ApiException(0, "NETWORK_ERROR", "Unable to resolve host") to LoginError.Offline,
            ApiException(0, "TLS_ERROR", "Trust anchor for certification path not found") to LoginError.InsecureConnection,
            SecureStorageUnavailableException() to LoginError.StorageUnavailable,
            ApiException(500, null, "Internal") to LoginError.Unexpected,
            IllegalStateException("boom") to LoginError.Unexpected
        ).forEach { (failure, expected) ->
            auth.onLogin = { _, _ -> throw failure }
            val vm = viewModel()

            vm.fillAndSubmit()
            runCurrent()

            assertEquals(LoginUiState.Error(expected), vm.uiState.value)
            assertEquals(0L, vm.retryAfterSeconds.value)
        }
    }

    @Test
    fun pendingAndRejectedRegistrationsOpenTheirOwnScreensOnce() = runTest(dispatcher) {
        mapOf(
            ApiException(403, "ACCOUNT_PENDING", "Заявка на рассмотрении") to LoginError.AccountPending,
            ApiException(403, "ACCOUNT_REJECTED", "Заявка отклонена") to LoginError.AccountRejected
        ).forEach { (failure, expected) ->
            auth.onLogin = { _, _ -> throw failure }
            val vm = viewModel()

            vm.fillAndSubmit()
            runCurrent()

            assertEquals(LoginUiState.Error(expected), vm.uiState.value)
            assertNull("a registration is not a remembered sign-in", preferences.lastUsername)

            vm.onAccountStateShown()
            assertEquals("the screen is shown once; back returns to the form", LoginUiState.Idle, vm.uiState.value)
            assertTrue(vm.canSubmit.value)
        }
    }

    @Test
    fun aPlain403IsStillWrongCredentials() = runTest(dispatcher) {
        auth.onLogin = { _, _ -> throw ApiException(403, "ACCOUNT_DISABLED", "Учётная запись отключена") }
        val vm = viewModel()

        vm.fillAndSubmit()
        runCurrent()

        assertEquals(LoginUiState.Error(LoginError.InvalidCredentials), vm.uiState.value)
    }

    // --- abuse and convenience -----------------------------------------------------------------

    @Test
    fun aSecondSubmitWhileSigningInSendsNoSecondRequest() = runTest(dispatcher) {
        val gate = CompletableDeferred<LoginResult>()
        auth.onLogin = { _, _ -> gate.await() }
        val vm = viewModel()

        vm.fillAndSubmit()
        vm.submit()
        runCurrent()
        vm.submit()
        runCurrent()

        assertEquals(1, auth.loginAttempts.size)
        assertEquals(LoginUiState.Loading, vm.uiState.value)
        assertFalse(vm.canSubmit.value)

        gate.complete(LoginResult.SUCCESS)
        runCurrent()
        assertEquals(LoginUiState.Success, vm.uiState.value)
    }

    @Test
    fun submitNeedsBothFields() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        assertFalse(vm.canSubmit.value)

        vm.onUsernameChange("alice")
        runCurrent()
        assertFalse(vm.canSubmit.value)

        vm.onPasswordChange("Secret-1")
        runCurrent()
        assertTrue(vm.canSubmit.value)

        vm.onUsernameChange("   ")
        vm.submit()
        runCurrent()
        assertEquals(0, auth.loginAttempts.size)
    }

    @Test
    fun theLastLoginNameIsRememberedButNeverThePassword() = runTest(dispatcher) {
        val vm = viewModel()

        vm.fillAndSubmit(username = "  alice ", password = "Secret-1")
        runCurrent()

        assertEquals(LoginUiState.Success, vm.uiState.value)
        assertEquals("alice", preferences.lastUsername)
        assertEquals("the password does not outlive a successful sign-in", "", vm.password.value)

        val next = viewModel()
        assertEquals("alice", next.username.value)
        assertEquals("", next.password.value)
    }

    @Test
    fun aFailedSignInDoesNotRememberTheName() = runTest(dispatcher) {
        auth.onLogin = { _, _ -> throw ApiException(400, null, "Неверный логин или пароль") }
        val vm = viewModel()

        vm.fillAndSubmit(username = "typo-name")
        runCurrent()

        assertNull(preferences.lastUsername)
        assertEquals("the form keeps what was typed", "typo-name", vm.username.value)
    }
}
