package com.openmychat.mobile.features.auth

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.data.model.RegisterRequestBody
import com.openmychat.mobile.data.model.RegistrationChallenge
import com.openmychat.mobile.data.model.RegistrationOutcome
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.features.account.AccountFailure
import com.openmychat.mobile.features.auth.RegistrationState.Step
import com.openmychat.mobile.testing.FakeAccountRepository
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class RegistrationViewModelTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private var now = 1_000_000L
    private val account = FakeAccountRepository()
    private fun viewModel() = RegistrationViewModel(account) { now }

    private fun RegistrationViewModel.fillValidForm() {
        onEmailChange(" Ivan@Company.example ")
        onDisplayNameChange("Иван   Иванов")
        onUsernameChange("Ivanov")
        onPasswordChange("Secret-12")
    }

    private val state get() = vm.state.value
    private lateinit var vm: RegistrationViewModel

    // --- step 1: form ----------------------------------------------------------------------------

    @Test
    fun anInvalidFormShowsFieldProblemsAndSendsNothing() = runTest {
        vm = viewModel()
        assertNull("no hints before the first attempt", state.visibleProblem(RegistrationValidation.Field.EMAIL))

        vm.submitForm()

        assertEquals(RegistrationValidation.Problem.EMAIL_MISSING, state.visibleProblem(RegistrationValidation.Field.EMAIL))
        assertEquals(RegistrationValidation.Problem.PASSWORD_MISSING, state.visibleProblem(RegistrationValidation.Field.PASSWORD))
        assertEquals(Step.FORM, state.step)
        assertTrue(account.registrationRequests.isEmpty())
    }

    @Test
    fun aValidFormRequestsACodeWithNormalisedFields() = runTest {
        vm = viewModel()
        vm.fillValidForm()

        vm.submitForm()

        assertEquals(
            RegisterRequestBody(email = "ivan@company.example", username = "ivanov", displayName = "Иван Иванов", password = "Secret-12"),
            account.registrationRequests.single()
        )
        assertEquals(Step.CODE, state.step)
        assertEquals(600L, state.secondsUntilExpiry(now))
        assertEquals(60L, state.secondsUntilResend(now))
        assertFalse(state.canResend(now))
    }

    @Test
    fun missingMailSetupStaysOnTheFormWithItsMessage() = runTest {
        account.onRequest = { throw ApiException(503, null, "Отправка почты не настроена") }
        vm = viewModel()
        vm.fillValidForm()

        vm.submitForm()

        assertEquals(Step.FORM, state.step)
        assertEquals(AccountFailure.MailNotConfigured, state.failure)
        assertFalse(state.busy)
    }

    @Test
    fun aRateLimitBlocksTheFormUntilItsDeadline() = runTest {
        account.onRequest = { throw ApiException(429, null, "Слишком много", retryAfterSeconds = 30) }
        vm = viewModel()
        vm.fillValidForm()
        vm.submitForm()
        assertTrue(state.isWaiting(now))

        now += 10_000
        vm.submitForm()
        assertEquals("no request while the server asked to wait", 1, account.registrationRequests.size)

        now += 20_000
        assertFalse(state.isWaiting(now))
        account.onRequest = { RegistrationChallenge("code_sent", "r-1", 600) }
        vm.submitForm()
        assertEquals(Step.CODE, state.step)
    }

    @Test
    fun aSecondTapWhileSendingIsIgnored() = runTest {
        val gate = CompletableDeferred<RegistrationChallenge>()
        account.onRequest = { gate.await() }
        vm = viewModel()
        vm.fillValidForm()

        vm.submitForm()
        vm.submitForm()
        assertTrue(state.busy)
        gate.complete(RegistrationChallenge("code_sent", "r-1", 600))

        assertEquals(1, account.registrationRequests.size)
        assertFalse(state.busy)
    }

    // --- step 2: code ----------------------------------------------------------------------------

    private suspend fun onCodeStep(): RegistrationViewModel = viewModel().also {
        vm = it
        it.fillValidForm()
        it.submitForm()
    }

    @Test
    fun theCodeKeepsSixDigitsAndVerifiesOnlyWhenComplete() = runTest {
        onCodeStep()
        vm.onCodeChange("12 3")
        assertEquals("123", state.code)
        assertFalse(state.canVerify)
        vm.verify()
        assertTrue(account.verifications.isEmpty())

        vm.onCodeChange("123456789")
        assertEquals("123456", state.code)
        assertTrue(state.canVerify)
    }

    @Test
    fun anAddressOffTheAllowListEndsOnThePendingScreenWithSecretsCleared() = runTest {
        account.onVerify = { _, _ -> RegistrationOutcome.Pending }
        onCodeStep()
        vm.onCodeChange("123456")

        vm.verify()

        assertEquals(listOf("r-1" to "123456"), account.verifications)
        assertEquals(Step.PENDING, state.step)
        assertEquals("", state.password)
        assertEquals("", state.code)
        assertFalse(state.signedIn)
    }

    @Test
    fun anAddressOnTheAllowListSignsIn() = runTest {
        account.onVerify = { _, _ -> RegistrationOutcome.SignedIn(User(id = 42, username = "ivanov", fullName = "Иван")) }
        onCodeStep()
        vm.onCodeChange("123456")

        vm.verify()

        assertTrue(state.signedIn)
        assertEquals("", state.password)
    }

    @Test
    fun aWrongCodeIsClearedAndTheAttemptsLeftAreShown() = runTest {
        account.onVerify = { _, _ -> throw ApiException(400, "CODE_INVALID", "Неверный код", attemptsLeft = 2) }
        onCodeStep()
        vm.onCodeChange("000000")

        vm.verify()

        assertEquals(AccountFailure.WrongCode("Неверный код", 2), state.failure)
        assertEquals("", state.code)
        assertEquals(Step.CODE, state.step)
    }

    @Test
    fun aCodePastItsLifetimeIsNotSent() = runTest {
        onCodeStep()
        vm.onCodeChange("123456")
        now += 600_000

        assertTrue(state.isCodeExpired(now))
        vm.verify()

        assertTrue(account.verifications.isEmpty())
        assertEquals(AccountFailure.CodeExpired, state.failure)
    }

    @Test
    fun resendWaitsAMinuteThenFollowsTheServersRetryAfter() = runTest {
        onCodeStep()
        vm.resend()
        assertEquals("too early", 1, account.registrationRequests.size)

        now += 60_000
        assertTrue(state.canResend(now))
        account.onRequest = { throw ApiException(429, null, "Слишком часто", retryAfterSeconds = 120) }
        vm.resend()

        assertEquals(2, account.registrationRequests.size)
        assertEquals(Step.CODE, state.step)
        assertEquals(120L, state.secondsUntilResend(now))
        assertFalse(state.canResend(now + 119_000))
        assertTrue(state.canResend(now + 120_000))
    }

    @Test
    fun aResentCodeRestartsBothClocks() = runTest {
        onCodeStep()
        now += 300_000
        account.onRequest = { RegistrationChallenge("code_sent", "r-2", 600) }

        vm.resend()

        assertEquals(600L, state.secondsUntilExpiry(now))
        assertEquals(60L, state.secondsUntilResend(now))
        vm.onCodeChange("654321")
        account.onVerify = { _, _ -> RegistrationOutcome.Pending }
        vm.verify()
        assertEquals("r-2" to "654321", account.verifications.single())
    }

    @Test
    fun goingBackToTheFormDropsTheCode() = runTest {
        onCodeStep()
        vm.onCodeChange("123")

        vm.backToForm()

        assertEquals(Step.FORM, state.step)
        assertEquals("", state.code)
        assertNull(state.failure)
        assertEquals("Secret-12", state.password)
    }

    @Test
    fun aRateLimitedCodeCheckWaitsForItsDeadline() = runTest {
        onCodeStep()
        vm.onCodeChange("123456")
        account.onVerify = { _, _ -> throw ApiException(429, null, "Слишком часто", retryAfterSeconds = 30) }
        vm.verify()
        assertEquals(AccountFailure.Throttled(now + 30_000), state.failure)

        account.onVerify = { _, _ -> RegistrationOutcome.Pending }
        assertFalse(state.canVerifyAt(now))
        vm.verify()
        assertEquals("no second check while the server's wait runs", 1, account.verifications.size)

        now += 30_000
        assertTrue("the wait is over: «Подтвердить» works again", state.canVerifyAt(now))
        vm.verify()
        assertEquals(2, account.verifications.size)
        assertEquals(Step.PENDING, state.step)
    }

    @Test
    fun aCancelledCodeCheckIsNotReportedAsAFailure() = runTest {
        onCodeStep()
        vm.onCodeChange("123456")
        account.onVerify = { _, _ -> throw kotlinx.coroutines.CancellationException("screen closed") }

        vm.verify()

        assertNull(state.failure)
    }
}
