package com.openmychat.mobile.features.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.MustChangePasswordException
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.ChangePasswordRequest
import com.openmychat.mobile.data.model.DeviceClaimRequest
import com.openmychat.mobile.data.model.LoginRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.security.SecureRandom

sealed interface LoginUiState {
    data object Idle : LoginUiState
    data object Loading : LoginUiState
    data object Success : LoginUiState
    data class Error(val message: String) : LoginUiState
}

class LoginViewModel(
    private val apiClient: ApiClient,
    private val sessionManager: SessionManager
) : ViewModel() {

    private val _uiState = MutableStateFlow<LoginUiState>(LoginUiState.Idle)
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    private val _mustChangePasswordDialogVisible = MutableStateFlow(false)
    val mustChangePasswordDialogVisible: StateFlow<Boolean> = _mustChangePasswordDialogVisible.asStateFlow()

    private val _changePasswordLoading = MutableStateFlow(false)
    val changePasswordLoading: StateFlow<Boolean> = _changePasswordLoading.asStateFlow()

    private val _changePasswordError = MutableStateFlow<String?>(null)
    val changePasswordError: StateFlow<String?> = _changePasswordError.asStateFlow()

    var lastEnteredPassword = ""
        private set

    init {
        // Observe SessionManager's mustChangePassword flow
        viewModelScope.launch {
            sessionManager.mustChangePasswordFlow.collect { mustChange ->
                if (mustChange && sessionManager.token != null) {
                    _mustChangePasswordDialogVisible.value = true
                }
            }
        }
    }

    fun login(username: String, password: String) {
        if (username.isBlank() || password.isBlank()) {
            _uiState.value = LoginUiState.Error("Введите имя пользователя и пароль")
            return
        }

        lastEnteredPassword = password
        viewModelScope.launch {
            _uiState.value = LoginUiState.Loading
            try {
                val resp = apiClient.login(LoginRequest(username = username.trim(), password = password))

                // Attempt device claim with a random 256-bit secret (base64url)
                try {
                    val secretBytes = ByteArray(32)
                    SecureRandom().nextBytes(secretBytes)
                    val secretString = android.util.Base64.encodeToString(
                        secretBytes,
                        android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP
                    )
                    val claimResp = apiClient.claimDevice(
                        DeviceClaimRequest(
                            deviceId = sessionManager.deviceId,
                            deviceSecret = secretString
                        )
                    )
                    if (claimResp.claimed) {
                        sessionManager.deviceSecret = secretString
                    }
                } catch (_: Exception) {}

                if (resp.user.mustChangePassword) {
                    sessionManager.mustChangePassword = true
                    _mustChangePasswordDialogVisible.value = true
                    _uiState.value = LoginUiState.Idle
                } else {
                    _uiState.value = LoginUiState.Success
                }
            } catch (e: MustChangePasswordException) {
                sessionManager.mustChangePassword = true
                _mustChangePasswordDialogVisible.value = true
                _uiState.value = LoginUiState.Idle
            } catch (e: SecureStorageUnavailableException) {
                _uiState.value = LoginUiState.Error(e.message ?: "Secure storage is unavailable")
            } catch (e: Exception) {
                _uiState.value = LoginUiState.Error(e.message ?: "Ошибка авторизации")
            }
        }
    }

    fun changePassword(oldPass: String, newPass: String) {
        viewModelScope.launch {
            _changePasswordLoading.value = true
            _changePasswordError.value = null
            try {
                val resp = apiClient.changePassword(
                    ChangePasswordRequest(
                        oldPassword = oldPass,
                        newPassword = newPass
                    )
                )
                if (resp.success) {
                    _mustChangePasswordDialogVisible.value = false
                    sessionManager.mustChangePassword = false
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
        if (!sessionManager.mustChangePassword) {
            _mustChangePasswordDialogVisible.value = false
        }
    }
}
