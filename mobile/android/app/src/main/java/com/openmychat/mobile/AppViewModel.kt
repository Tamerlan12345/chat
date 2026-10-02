package com.openmychat.mobile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.data.repository.AuthRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.ui.navigation.AuthenticatedRouteState
import com.openmychat.mobile.ui.navigation.SessionRouteGuard
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** State of the global, non-dismissable password change dialog. */
sealed interface PasswordChangeUiState {
    data object Hidden : PasswordChangeUiState
    data class Visible(val isLoading: Boolean = false, val error: String? = null) : PasswordChangeUiState
}

/** Activity-level state: session gating, the forced password change and app-wide realtime events. */
@HiltViewModel
class AppViewModel @Inject constructor(
    private val sessionRepository: SessionRepository,
    private val authRepository: AuthRepository,
    private val realtimeRepository: RealtimeRepository
) : ViewModel() {

    val routeStates: Flow<AuthenticatedRouteState> get() = sessionRepository.routeStates
    fun routeState(): AuthenticatedRouteState = sessionRepository.routeState()
    fun acceptsIncomingCall(): Boolean = SessionRouteGuard.acceptsIncomingCall(routeState())

    /** Events handled above any single screen: wake buzz, incoming calls, forced disconnects. */
    val globalEvents: Flow<WsEvent> = realtimeRepository.events.filter { event ->
        event is WsEvent.WakeRing || event is WsEvent.CallOffer || event is WsEvent.ServerDisconnect
    }

    /** Another call is already open: tell the caller instead of silently ignoring the offer. */
    fun rejectBusy(callerId: Long) {
        realtimeRepository.sendCallRejected(callerId, "Абонент занят другим звонком")
    }

    private val changeInFlight = MutableStateFlow(PasswordChangeUiState.Visible())

    val passwordChange: StateFlow<PasswordChangeUiState> = combine(
        sessionRepository.mustChangePassword,
        sessionRepository.token,
        changeInFlight
    ) { mustChange, token, visible ->
        if (mustChange && token != null) visible else PasswordChangeUiState.Hidden
    }.stateIn(viewModelScope, SharingStarted.Eagerly, PasswordChangeUiState.Hidden)

    fun changePassword(oldPassword: String, newPassword: String) {
        viewModelScope.launch {
            changeInFlight.value = PasswordChangeUiState.Visible(isLoading = true)
            changeInFlight.value = try {
                val resp = authRepository.changePassword(oldPassword, newPassword)
                if (resp.success) PasswordChangeUiState.Visible()
                else PasswordChangeUiState.Visible(error = resp.message.ifBlank { "Ошибка смены пароля" })
            } catch (e: SecureStorageUnavailableException) {
                PasswordChangeUiState.Visible(error = e.message ?: "Не удалось сменить пароль. Повторите попытку.")
            } catch (_: Exception) {
                PasswordChangeUiState.Visible(error = "Не удалось сменить пароль. Повторите попытку.")
            }
        }
    }
}
