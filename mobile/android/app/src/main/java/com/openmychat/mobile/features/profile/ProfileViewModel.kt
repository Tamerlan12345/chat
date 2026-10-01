package com.openmychat.mobile.features.profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.UpdateProfileRequest
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class ProfileViewModel(
    private val apiClient: ApiClient,
    private val webSocketClient: WebSocketClient,
    val sessionManager: SessionManager
) : ViewModel() {

    private val _currentUser = MutableStateFlow<User?>(sessionManager.currentUser)
    val currentUser: StateFlow<User?> = _currentUser.asStateFlow()

    private val _customStatusInput = MutableStateFlow(sessionManager.currentUser?.customStatus ?: "")
    val customStatusInput: StateFlow<String> = _customStatusInput.asStateFlow()

    private val _wakeCooldown = MutableStateFlow(0)
    val wakeCooldown: StateFlow<Int> = _wakeCooldown.asStateFlow()

    private val _isSaving = MutableStateFlow(false)
    val isSaving: StateFlow<Boolean> = _isSaving.asStateFlow()

    private val _logoutError = MutableStateFlow<String?>(null)
    val logoutError: StateFlow<String?> = _logoutError.asStateFlow()

    private var cooldownJob: Job? = null

    init {
        refreshProfile()
    }

    fun refreshProfile() {
        viewModelScope.launch {
            try {
                val user = apiClient.getMe()
                _currentUser.value = user
                _customStatusInput.value = user.customStatus ?: ""
            } catch (_: Exception) {}
        }
    }

    fun updateCustomStatusInput(text: String) {
        _customStatusInput.value = text
    }

    fun setStatus(status: UserStatus) {
        viewModelScope.launch {
            val user = _currentUser.value ?: return@launch
            val updated = user.copy(status = status)
            _currentUser.value = updated
            sessionManager.currentUser = updated

            if (status == UserStatus.DND) {
                webSocketClient.setDnd(true, _customStatusInput.value.ifBlank { null })
            } else {
                webSocketClient.setDnd(false)
                webSocketClient.sendPresence(status.value, _customStatusInput.value.ifBlank { null })
            }
        }
    }

    fun saveCustomStatus() {
        viewModelScope.launch {
            _isSaving.value = true
            try {
                val updatedText = _customStatusInput.value.trim()
                val updatedUser = apiClient.updateProfile(
                    UpdateProfileRequest(customStatus = updatedText.ifBlank { null })
                )
                _currentUser.value = updatedUser
                val currentStatus = updatedUser.status
                if (currentStatus == UserStatus.DND) {
                    webSocketClient.setDnd(true, updatedText.ifBlank { null })
                } else {
                    webSocketClient.sendPresence(currentStatus.value, updatedText.ifBlank { null })
                }
            } catch (_: Exception) {} finally {
                _isSaving.value = false
            }
        }
    }

    fun sendWakeToColleague(targetUserId: Long) {
        if (_wakeCooldown.value > 0) return
        webSocketClient.sendWake(targetUserId)
        startWakeCooldown(60)
    }

    private fun startWakeCooldown(seconds: Int) {
        cooldownJob?.cancel()
        _wakeCooldown.value = seconds
        cooldownJob = viewModelScope.launch {
            while (_wakeCooldown.value > 0) {
                delay(1000)
                _wakeCooldown.value -= 1
            }
        }
    }

    fun logout(onLoggedOut: () -> Unit) {
        viewModelScope.launch {
            _logoutError.value = null
            try {
                apiClient.logout()
            } catch (error: SecureStorageUnavailableException) {
                _logoutError.value = error.message ?: "Secure storage is unavailable"
                return@launch
            } catch (_: Exception) {
                if (!sessionManager.clearSession()) {
                    _logoutError.value = "Secure storage is unavailable"
                    return@launch
                }
            }
            webSocketClient.disconnect()
            onLoggedOut()
        }
    }
}
