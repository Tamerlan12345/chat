package com.openmychat.mobile.features.profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.repository.AuthRepository
import com.openmychat.mobile.data.repository.ProfileRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Screen state of the profile tab. One-off failures are exposed separately as messages. */
sealed interface ProfileUiState {
    val customStatusInput: String
    val wakeCooldownSeconds: Int
    val isSaving: Boolean

    data class Loading(
        override val customStatusInput: String = "",
        override val wakeCooldownSeconds: Int = 0,
        override val isSaving: Boolean = false
    ) : ProfileUiState

    data class Content(
        val user: User,
        override val customStatusInput: String,
        override val wakeCooldownSeconds: Int = 0,
        override val isSaving: Boolean = false
    ) : ProfileUiState
}

@HiltViewModel
class ProfileViewModel @Inject constructor(
    private val profileRepository: ProfileRepository,
    private val authRepository: AuthRepository,
    private val realtimeRepository: RealtimeRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(initialState(profileRepository.cachedUser))
    val uiState: StateFlow<ProfileUiState> = _uiState.asStateFlow()

    private val _logoutError = MutableStateFlow<String?>(null)
    val logoutError: StateFlow<String?> = _logoutError.asStateFlow()

    private val _storageError = MutableStateFlow<String?>(null)
    val storageError: StateFlow<String?> = _storageError.asStateFlow()

    private var cooldownJob: Job? = null

    init {
        refreshProfile()
    }

    private val currentUser: User? get() = (_uiState.value as? ProfileUiState.Content)?.user

    private fun initialState(user: User?): ProfileUiState =
        if (user != null) ProfileUiState.Content(user, user.customStatus ?: "") else ProfileUiState.Loading()

    private fun showUser(user: User, customStatusInput: String = _uiState.value.customStatusInput) {
        _uiState.update { state ->
            ProfileUiState.Content(
                user = user,
                customStatusInput = customStatusInput,
                wakeCooldownSeconds = state.wakeCooldownSeconds,
                isSaving = state.isSaving
            )
        }
    }

    private fun showCachedUser() {
        val cached = profileRepository.cachedUser
        if (cached != null) showUser(cached) else _uiState.update {
            ProfileUiState.Loading(it.customStatusInput, it.wakeCooldownSeconds, it.isSaving)
        }
    }

    fun refreshProfile() {
        viewModelScope.launch {
            try {
                val user = profileRepository.me()
                showUser(user, user.customStatus ?: "")
            } catch (error: SecureStorageUnavailableException) {
                _storageError.value = error.message ?: "Secure storage is unavailable"
            } catch (_: Exception) {
            }
        }
    }

    fun updateCustomStatusInput(text: String) {
        _uiState.update { state ->
            when (state) {
                is ProfileUiState.Content -> state.copy(customStatusInput = text)
                is ProfileUiState.Loading -> state.copy(customStatusInput = text)
            }
        }
    }

    private fun setSaving(saving: Boolean) {
        _uiState.update { state ->
            when (state) {
                is ProfileUiState.Content -> state.copy(isSaving = saving)
                is ProfileUiState.Loading -> state.copy(isSaving = saving)
            }
        }
    }

    fun setStatus(status: UserStatus) {
        viewModelScope.launch {
            _storageError.value = null
            val user = currentUser ?: return@launch
            val updated = user.copy(status = status)
            try {
                profileRepository.storeUser(updated)
                showUser(updated)
            } catch (error: SecureStorageUnavailableException) {
                showCachedUser()
                _storageError.value = error.message ?: "Secure storage is unavailable"
                return@launch
            }

            val customStatus = _uiState.value.customStatusInput.ifBlank { null }
            if (status == UserStatus.DND) {
                realtimeRepository.setDnd(true, customStatus)
            } else {
                realtimeRepository.setDnd(false)
                realtimeRepository.sendPresence(status.value, customStatus)
            }
        }
    }

    fun saveCustomStatus() {
        viewModelScope.launch {
            setSaving(true)
            try {
                val updatedText = _uiState.value.customStatusInput.trim()
                val updatedUser = profileRepository.updateCustomStatus(updatedText.ifBlank { null })
                showUser(updatedUser)
                val currentStatus = updatedUser.status
                if (currentStatus == UserStatus.DND) {
                    realtimeRepository.setDnd(true, updatedText.ifBlank { null })
                } else {
                    realtimeRepository.sendPresence(currentStatus.value, updatedText.ifBlank { null })
                }
            } catch (error: SecureStorageUnavailableException) {
                showCachedUser()
                _storageError.value = error.message ?: "Secure storage is unavailable"
            } catch (_: Exception) {
            } finally {
                setSaving(false)
            }
        }
    }

    fun sendWakeToColleague(targetUserId: Long) {
        if (_uiState.value.wakeCooldownSeconds > 0) return
        realtimeRepository.sendWake(targetUserId)
        startWakeCooldown(60)
    }

    private fun setCooldown(seconds: Int) {
        _uiState.update { state ->
            when (state) {
                is ProfileUiState.Content -> state.copy(wakeCooldownSeconds = seconds)
                is ProfileUiState.Loading -> state.copy(wakeCooldownSeconds = seconds)
            }
        }
    }

    private fun startWakeCooldown(seconds: Int) {
        cooldownJob?.cancel()
        setCooldown(seconds)
        cooldownJob = viewModelScope.launch {
            while (_uiState.value.wakeCooldownSeconds > 0) {
                delay(1000)
                setCooldown(_uiState.value.wakeCooldownSeconds - 1)
            }
        }
    }

    /** Clears the session; [onLoggedOut] runs only once local credentials are really gone. */
    fun logout(onLoggedOut: () -> Unit) {
        viewModelScope.launch {
            _logoutError.value = null
            try {
                authRepository.logout()
            } catch (error: SecureStorageUnavailableException) {
                _logoutError.value = error.message ?: "Secure storage is unavailable"
                return@launch
            }
            onLoggedOut()
        }
    }
}
