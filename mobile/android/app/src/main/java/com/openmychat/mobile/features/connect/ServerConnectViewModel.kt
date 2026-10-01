package com.openmychat.mobile.features.connect

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.HealthStatus
import com.openmychat.mobile.data.model.KnockRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface ServerConnectUiState {
    data object Idle : ServerConnectUiState
    data object Checking : ServerConnectUiState
    data class Success(val health: HealthStatus, val knockStatus: String? = null) : ServerConnectUiState
    data class Error(val message: String) : ServerConnectUiState
}

class ServerConnectViewModel(
    private val apiClient: ApiClient,
    private val sessionManager: SessionManager
) : ViewModel() {

    private val _serverUrl = MutableStateFlow(sessionManager.serverUrl)
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
                val endpoint = sessionManager.validateServerEndpoint(_serverUrl.value)
                    .getOrElse { throw it }
                val health = apiClient.checkHealthAt(endpoint)

                // Try device knock
                val knockResp = try {
                    apiClient.knockAt(
                        endpoint,
                        KnockRequest(
                            deviceId = sessionManager.deviceId,
                            deviceSecret = null,
                            deviceName = "Android Device"
                        )
                    )
                } catch (_: Exception) {
                    null
                }

                sessionManager.commitVerifiedServerEndpoint(endpoint)
                _uiState.value = ServerConnectUiState.Success(
                    health = health,
                    knockStatus = knockResp?.status
                )

                if (knockResp?.status == "paired" && knockResp.token != null && knockResp.user != null) {
                    sessionManager.saveAuthSuccess(knockResp.user, knockResp.token)
                    onSuccess(true)
                } else {
                    onSuccess(false)
                }
            } catch (e: SecureStorageUnavailableException) {
                sessionManager.restorePersistedServerEndpoint()
                _uiState.value = ServerConnectUiState.Error(
                    e.message ?: "Secure storage is unavailable"
                )
            } catch (e: Exception) {
                sessionManager.restorePersistedServerEndpoint()
                _uiState.value = ServerConnectUiState.Error(
                    e.message ?: "Не удалось подключиться к серверу"
                )
            }
        }
    }
}
