package com.openmychat.mobile.features.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.data.model.RegisterRequestBody
import com.openmychat.mobile.data.model.RegistrationChallenge
import com.openmychat.mobile.data.model.RegistrationOutcome
import com.openmychat.mobile.data.repository.AccountRepository
import com.openmychat.mobile.features.account.AccountFailure
import com.openmychat.mobile.features.auth.RegistrationValidation.Field
import com.openmychat.mobile.features.auth.RegistrationValidation.Problem
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Registration as one state: the form, the e-mail code and the «waiting for the administrator» result. */
data class RegistrationState(
    val step: Step = Step.FORM,
    val email: String = "",
    val displayName: String = "",
    val username: String = "",
    /** Memory only; cleared as soon as the flow ends. */
    val password: String = "",
    val code: String = "",
    val busy: Boolean = false,
    /** Field hints appear only after the first attempt to continue. */
    val showsValidation: Boolean = false,
    val failure: AccountFailure? = null,
    val challenge: RegistrationChallenge? = null,
    val codeExpiresAt: Long? = null,
    val resendAvailableAt: Long? = null,
    /** The code was confirmed and a session stored: the app opens. */
    val signedIn: Boolean = false
) {
    enum class Step { FORM, CODE, PENDING }

    val problems: Map<Field, Problem> get() = RegistrationValidation.problems(email, displayName, username, password)

    fun visibleProblem(field: Field): Problem? = if (showsValidation) problems[field] else null

    val canVerify: Boolean get() = step == Step.CODE && !busy && code.length == RegistrationValidation.CODE_LENGTH

    /** [canVerify] and no server wait (429) running at [now]. */
    fun canVerifyAt(now: Long): Boolean = canVerify && !isWaiting(now)

    /** A rate-limit wait is on at [now]. */
    fun isWaiting(now: Long): Boolean = failure?.retryDeadline?.let { now < it } == true

    fun isCodeExpired(now: Long): Boolean = codeExpiresAt?.let { now >= it } == true

    /** Whole seconds the code stays valid; null when no code was sent. */
    fun secondsUntilExpiry(now: Long): Long? = codeExpiresAt?.let { secondsUntil(it, now) }

    /** Whole seconds until a new code may be requested; 0 when it may be requested now. */
    fun secondsUntilResend(now: Long): Long = resendAvailableAt?.let { secondsUntil(it, now) } ?: 0

    fun canResend(now: Long): Boolean = step == Step.CODE && !busy && secondsUntilResend(now) == 0L

    private fun secondsUntil(deadline: Long, now: Long) = ((deadline - now + 999) / 1_000).coerceAtLeast(0)
}

/**
 * Self-registration (contracts/registration.md §1): the form asks for a code by e-mail, the code is
 * confirmed, and the account is either active at once (signed in) or waits for an administrator.
 */
@HiltViewModel
class RegistrationViewModel(
    private val account: AccountRepository,
    private val clock: () -> Long
) : ViewModel() {

    @Inject
    constructor(account: AccountRepository) : this(account, System::currentTimeMillis)

    private val _state = MutableStateFlow(RegistrationState())
    val state: StateFlow<RegistrationState> = _state.asStateFlow()

    fun onEmailChange(value: String) = _state.update { it.copy(email = value) }
    fun onDisplayNameChange(value: String) = _state.update { it.copy(displayName = value) }
    fun onUsernameChange(value: String) = _state.update { it.copy(username = value) }
    fun onPasswordChange(value: String) = _state.update { it.copy(password = value) }
    fun onCodeChange(raw: String) = _state.update { it.copy(code = RegistrationValidation.sanitizedCode(raw)) }

    /** Step 1: asks the server to e-mail a code. */
    fun submitForm() {
        val current = _state.value
        if (current.step != RegistrationState.Step.FORM || current.busy) return
        _state.update { it.copy(showsValidation = true) }
        if (current.problems.isNotEmpty() || current.isWaiting(clock())) return
        requestCode()
    }

    /** Asks for a fresh code with the same data, once the resend wait is over. */
    fun resend() {
        if (!_state.value.canResend(clock())) return
        requestCode()
    }

    /** Step 2: checks the code. Signed in → [RegistrationState.signedIn]; otherwise the pending screen. */
    fun verify() {
        val current = _state.value
        val challenge = current.challenge ?: return
        if (!current.canVerifyAt(clock())) return
        if (current.isCodeExpired(clock())) {
            _state.update { it.copy(failure = AccountFailure.CodeExpired, code = "") }
            return
        }
        _state.update { it.copy(busy = true, failure = null) }
        viewModelScope.launch {
            try {
                when (account.verifyRegistration(challenge.registrationId, current.code)) {
                    is RegistrationOutcome.SignedIn -> _state.update { it.cleared().copy(signedIn = true) }
                    RegistrationOutcome.Pending -> _state.update { it.cleared().copy(step = RegistrationState.Step.PENDING) }
                }
            } catch (error: CancellationException) {
                _state.update { it.copy(busy = false) }
                throw error
            } catch (error: Exception) {
                val failure = AccountFailure.from(error, AccountFailure.Context.REGISTRATION_VERIFY, clock())
                // A wrong or dead code can never work again: the field is emptied for a new one.
                val dropCode = failure is AccountFailure.WrongCode || failure == AccountFailure.CodeExpired
                _state.update { it.copy(busy = false, failure = failure, code = if (dropCode) "" else it.code) }
            }
        }
    }

    /** Back to the form to fix the e-mail or any other field; the old code is dropped. */
    fun backToForm() {
        if (_state.value.step != RegistrationState.Step.CODE || _state.value.busy) return
        _state.update {
            it.copy(
                step = RegistrationState.Step.FORM,
                code = "",
                failure = null,
                challenge = null,
                codeExpiresAt = null,
                resendAvailableAt = null
            )
        }
    }

    private fun requestCode() {
        val current = _state.value
        _state.update { it.copy(busy = true, failure = null) }
        val body = RegisterRequestBody(
            email = RegistrationValidation.normalizedEmail(current.email),
            username = RegistrationValidation.normalizedUsername(current.username),
            displayName = RegistrationValidation.normalizedName(current.displayName),
            password = current.password
        )
        viewModelScope.launch {
            try {
                val challenge = account.requestRegistration(body)
                val sentAt = clock()
                _state.update {
                    it.copy(
                        busy = false,
                        step = RegistrationState.Step.CODE,
                        challenge = challenge,
                        code = "",
                        codeExpiresAt = sentAt + challenge.expiresInSec * 1_000L,
                        resendAvailableAt = sentAt + RESEND_INTERVAL_MS
                    )
                }
            } catch (error: CancellationException) {
                _state.update { it.copy(busy = false) }
                throw error
            } catch (error: Exception) {
                val failure = AccountFailure.from(error, AccountFailure.Context.REGISTRATION_REQUEST, clock())
                _state.update { state ->
                    // A resend the server throttled waits as long as the server asked.
                    val resendAt = failure.retryDeadline?.let { deadline -> maxOf(deadline, state.resendAvailableAt ?: 0) }
                        ?: state.resendAvailableAt
                    state.copy(busy = false, failure = failure, resendAvailableAt = resendAt)
                }
            }
        }
    }

    private fun RegistrationState.cleared() = copy(busy = false, password = "", code = "", failure = null)

    companion object {
        /** How long «Отправить код ещё раз» stays disabled after a code was sent. */
        const val RESEND_INTERVAL_MS = 60_000L
    }
}
