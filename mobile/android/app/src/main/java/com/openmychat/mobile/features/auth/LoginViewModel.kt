package com.openmychat.mobile.features.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.data.repository.AuthRepository
import com.openmychat.mobile.data.repository.LoginResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Why a sign-in did not go through. The screen maps each to Russian copy. */
sealed interface LoginError {
    data object EmptyFields : LoginError

    /** Wrong password and unknown login look the same: the screen never reveals which. */
    data object InvalidCredentials : LoginError

    /** 429: too many attempts; [LoginViewModel.retryAfterSeconds] counts down. */
    data object Throttled : LoginError

    /** 503 `LOGIN_BUSY`: the server is overloaded; [LoginViewModel.retryAfterSeconds] counts down. */
    data object ServerBusy : LoginError
    data object Offline : LoginError

    /** The TLS handshake failed (system trust, hostname check). */
    data object InsecureConnection : LoginError
    data object StorageUnavailable : LoginError
    data object Unexpected : LoginError
}

sealed interface LoginUiState {
    data object Idle : LoginUiState
    data object Loading : LoginUiState
    data object Success : LoginUiState
    data class Error(val error: LoginError) : LoginUiState
}

/**
 * Login form state. The password lives only in memory here (never in saved state or preferences)
 * and is cleared after a successful sign-in; only the login name is remembered, and only after a
 * successful sign-in.
 */
@HiltViewModel
class LoginViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val loginPreferences: LoginPreferences
) : ViewModel() {

    private val _uiState = MutableStateFlow<LoginUiState>(LoginUiState.Idle)
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    private val _username = MutableStateFlow(loginPreferences.lastUsername.orEmpty())
    val username: StateFlow<String> = _username.asStateFlow()

    private val _password = MutableStateFlow("")
    val password: StateFlow<String> = _password.asStateFlow()

    /** Seconds until the server accepts another attempt (429/503); 0 when not throttled. */
    private val _retryAfterSeconds = MutableStateFlow(0L)
    val retryAfterSeconds: StateFlow<Long> = _retryAfterSeconds.asStateFlow()

    /** Sanitised `company_name` from the server; null means "show the default subtitle". */
    private val _companyName = MutableStateFlow<String?>(null)
    val companyName: StateFlow<String?> = _companyName.asStateFlow()

    val canSubmit: StateFlow<Boolean> = combine(_username, _password, _uiState, _retryAfterSeconds) { name, pass, state, wait ->
        isSubmittable(name, pass, state, wait)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, false)

    private val _mustChangePasswordDialogVisible = MutableStateFlow(false)
    val mustChangePasswordDialogVisible: StateFlow<Boolean> = _mustChangePasswordDialogVisible.asStateFlow()

    private val _changePasswordLoading = MutableStateFlow(false)
    val changePasswordLoading: StateFlow<Boolean> = _changePasswordLoading.asStateFlow()

    private val _changePasswordError = MutableStateFlow<String?>(null)
    val changePasswordError: StateFlow<String?> = _changePasswordError.asStateFlow()

    /** Pre-fills the forced password change; memory only, cleared once the change succeeds. */
    var lastEnteredPassword = ""
        private set

    private var screenShown = false
    private var countdown: Job? = null

    init {
        viewModelScope.launch {
            authRepository.mustChangePassword.collect { mustChange ->
                if (mustChange && authRepository.hasSessionToken) {
                    _mustChangePasswordDialogVisible.value = true
                }
            }
        }
    }

    fun onUsernameChange(value: String) {
        _username.value = value
    }

    fun onPasswordChange(value: String) {
        _password.value = value
    }

    fun submit() = login(_username.value, _password.value)

    /**
     * Runs once per login screen: loads the company name for the header and announces the device
     * to the server (`/auth/knock`, formerly part of server setup). A paired device with a valid
     * session signs in without a password; any failure just leaves the form in place.
     */
    fun onScreenShown() {
        if (screenShown) return
        screenShown = true
        viewModelScope.launch {
            _companyName.value = try {
                CompanyName.sanitize(authRepository.companyName())
            } catch (_: Exception) {
                null
            }
        }
        viewModelScope.launch {
            val paired = try {
                authRepository.knock()
            } catch (_: Exception) {
                false
            }
            if (paired && (_uiState.value is LoginUiState.Idle || _uiState.value is LoginUiState.Error)) {
                _uiState.value = LoginUiState.Success
            }
        }
    }

    fun login(username: String, password: String) {
        // One request at a time, and none while the server has asked us to wait.
        if (_uiState.value is LoginUiState.Loading || _uiState.value is LoginUiState.Success) return
        if (_retryAfterSeconds.value > 0) return
        if (username.isBlank() || password.isBlank()) {
            _uiState.value = LoginUiState.Error(LoginError.EmptyFields)
            return
        }

        lastEnteredPassword = password
        _uiState.value = LoginUiState.Loading // synchronously, so a second tap is ignored
        viewModelScope.launch {
            try {
                val result = authRepository.login(username, password)
                loginPreferences.lastUsername = username.trim()
                _password.value = ""
                when (result) {
                    LoginResult.SUCCESS -> _uiState.value = LoginUiState.Success
                    LoginResult.MUST_CHANGE_PASSWORD -> {
                        _mustChangePasswordDialogVisible.value = true
                        _uiState.value = LoginUiState.Idle
                    }
                }
            } catch (failure: Exception) {
                val (error, waitSeconds) = classify(failure)
                _uiState.value = LoginUiState.Error(error)
                if (waitSeconds > 0) startCountdown(waitSeconds)
            }
        }
    }

    private fun startCountdown(seconds: Long) {
        countdown?.cancel()
        _retryAfterSeconds.value = seconds
        countdown = viewModelScope.launch {
            while (_retryAfterSeconds.value > 0) {
                delay(1_000)
                _retryAfterSeconds.value -= 1
            }
            // The wait is over; the message would now be stale. No automatic retry.
            val state = _uiState.value
            if (state is LoginUiState.Error && (state.error == LoginError.Throttled || state.error == LoginError.ServerBusy)) {
                _uiState.value = LoginUiState.Idle
            }
        }
    }

    fun changePassword(oldPass: String, newPass: String) {
        viewModelScope.launch {
            _changePasswordLoading.value = true
            _changePasswordError.value = null
            try {
                val resp = authRepository.changePassword(oldPass, newPass)
                if (resp.success) {
                    lastEnteredPassword = ""
                    _mustChangePasswordDialogVisible.value = false
                    _uiState.value = LoginUiState.Success
                } else {
                    _changePasswordError.value = resp.message.ifBlank { "Ошибка смены пароля" }
                }
            } catch (e: Exception) {
                _changePasswordError.value = e.message ?: "Ошибка смены пароля"
            } finally {
                _changePasswordLoading.value = false
            }
        }
    }

    fun dismissChangePasswordDialog() {
        // If not forced by server, allow dismissing
        if (!authRepository.isPasswordChangeForced) {
            _mustChangePasswordDialogVisible.value = false
        }
    }

    companion object {
        /** Used when the server throttles without a usable `Retry-After`. */
        const val DEFAULT_THROTTLE_SECONDS = 60L
        const val DEFAULT_BUSY_SECONDS = 5L

        /** Server ceiling for Retry-After on login (LoginThrottle RETRY_AFTER_CAP_MS). */
        private const val MAX_WAIT_SECONDS = 3_600L

        internal fun isSubmittable(username: String, password: String, state: LoginUiState, waitSeconds: Long) =
            username.isNotBlank() && password.isNotEmpty() && waitSeconds == 0L &&
                state !is LoginUiState.Loading && state !is LoginUiState.Success

        /**
         * Maps a failed sign-in to what the screen may say. The server's own message is never
         * shown: 400 (wrong password, unknown or disabled login) and 401 read the same.
         */
        internal fun classify(failure: Exception): Pair<LoginError, Long> = when (failure) {
            is SecureStorageUnavailableException -> LoginError.StorageUnavailable to 0L
            is ApiException -> when {
                failure.statusCode == 0 && failure.errorCode == "TLS_ERROR" -> LoginError.InsecureConnection to 0L
                failure.statusCode == 0 -> LoginError.Offline to 0L
                failure.statusCode == 400 || failure.statusCode == 401 || failure.statusCode == 403 ->
                    LoginError.InvalidCredentials to 0L
                failure.statusCode == 429 -> LoginError.Throttled to
                    (failure.retryAfterSeconds ?: DEFAULT_THROTTLE_SECONDS).coerceIn(1L, MAX_WAIT_SECONDS)
                failure.statusCode == 503 -> LoginError.ServerBusy to
                    (failure.retryAfterSeconds ?: DEFAULT_BUSY_SECONDS).coerceIn(1L, MAX_WAIT_SECONDS)
                else -> LoginError.Unexpected to 0L
            }
            else -> LoginError.Unexpected to 0L
        }
    }
}
