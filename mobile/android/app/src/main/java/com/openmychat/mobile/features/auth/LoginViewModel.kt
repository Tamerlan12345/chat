package com.openmychat.mobile.features.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.data.repository.AuthRepository
import com.openmychat.mobile.data.repository.LoginResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface LoginUiState {
    data object Idle : LoginUiState
    data object Loading : LoginUiState
    data object Success : LoginUiState
    data class Error(val message: String) : LoginUiState
}

@HiltViewModel
class LoginViewModel @Inject constructor(
    private val authRepository: AuthRepository
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
        viewModelScope.launch {
            authRepository.mustChangePassword.collect { mustChange ->
                if (mustChange && authRepository.hasSessionToken) {
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
                when (authRepository.login(username, password)) {
                    LoginResult.SUCCESS -> _uiState.value = LoginUiState.Success
                    LoginResult.MUST_CHANGE_PASSWORD -> {
                        _mustChangePasswordDialogVisible.value = true
                        _uiState.value = LoginUiState.Idle
                    }
                }
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
                val resp = authRepository.changePassword(oldPass, newPass)
                if (resp.success) {
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
}
