package com.openmychat.mobile.features.connect

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.data.model.HealthStatus
import com.openmychat.mobile.data.repository.AuthRepository
import com.openmychat.mobile.data.repository.ServerConnectResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface ServerConnectUiState {
    data object Idle : ServerConnectUiState
    data object Checking : ServerConnectUiState
    data class Success(val health: HealthStatus, val knockStatus: String? = null) : ServerConnectUiState
    data class Error(val message: String) : ServerConnectUiState
}

@HiltViewModel
class ServerConnectViewModel @Inject constructor(
    private val authRepository: AuthRepository
) : ViewModel() {

    private val _serverUrl = MutableStateFlow(authRepository.serverUrl)
    val serverUrl: StateFlow<String> = _serverUrl.asStateFlow()

    private val _uiState = MutableStateFlow<ServerConnectUiState>(ServerConnectUiState.Idle)
    val uiState: StateFlow<ServerConnectUiState> = _uiState.asStateFlow()

    fun updateServerUrl(url: String) {
        _serverUrl.value = url
    }

    fun checkConnection(onSuccess: (isPaired: Boolean) -> Unit) {
        viewModelScope.launch {
            _uiState.value = ServerConnectUiState.Checking
            try {
                val result = authRepository.connect(_serverUrl.value)
                _uiState.value = ServerConnectUiState.Success(
                    health = result.health,
                    knockStatus = result.knockStatus
                )
                onSuccess(result is ServerConnectResult.Paired)
            } catch (e: SecureStorageUnavailableException) {
                _uiState.value = ServerConnectUiState.Error(
                    e.message ?: "Secure storage is unavailable"
                )
            } catch (e: Exception) {
                _uiState.value = ServerConnectUiState.Error(
                    e.message ?: "Не удалось подключиться к серверу"
                )
            }
        }
    }
}
