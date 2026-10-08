package com.openmychat.mobile.features.profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.realtime.Presence
import com.openmychat.mobile.data.realtime.PresenceController
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.repository.AuthRepository
import com.openmychat.mobile.data.repository.ProfileRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import com.openmychat.mobile.data.delivery.OutgoingQueue
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
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

/** One-off outcomes for the snackbar. */
enum class ProfileEvent { StatusSaved, StatusSaveFailed }

/** Sign-out could not delete the unsent messages: the session stays (contract: never silently dropped or kept for another account). */
private const val UNSENT_NOT_DELETED = ProfileTexts.UNSENT_NOT_DELETED

/** Profile texts (copy-ru.md). */
object ProfileTexts {
    const val UNSENT_NOT_DELETED = "Не удалось удалить неотправленные сообщения. Выход отменён."
}

@HiltViewModel
class ProfileViewModel @Inject constructor(
    private val profileRepository: ProfileRepository,
    private val authRepository: AuthRepository,
    private val realtimeRepository: RealtimeRepository,
    private val presenceController: PresenceController,
    /** Unsent messages: sign-out deletes them, after the user agreed. */
    private val outgoing: OutgoingQueue = OutgoingQueue.None
) : ViewModel() {

    /** How many messages a sign-out now would delete («N неотправленных сообщений будут удалены»). */
    val unsentCount: StateFlow<Int> get() = outgoing.unsentCount
    val unsentKnown: StateFlow<Boolean> get() = outgoing.unsentKnown


    /** Автоматическое присутствие: на экране — «В сети», свёрнуто — «Отошёл». Только для показа. */
    val presence: StateFlow<Presence> = presenceController.presence

    /** «Не беспокоить» — единственный статус, который сотрудник выбирает сам. */
    private val _dnd = MutableStateFlow(profileRepository.cachedUser?.status == UserStatus.DND)
    val dnd: StateFlow<Boolean> = _dnd.asStateFlow()

    private val _uiState = MutableStateFlow(initialState(profileRepository.cachedUser))
    val uiState: StateFlow<ProfileUiState> = _uiState.asStateFlow()

    private val _logoutError = MutableStateFlow<String?>(null)
    val logoutError: StateFlow<String?> = _logoutError.asStateFlow()

    private val _storageError = MutableStateFlow<String?>(null)
    val storageError: StateFlow<String?> = _storageError.asStateFlow()

    private val _events = MutableSharedFlow<ProfileEvent>(extraBufferCapacity = 4)
    val events: SharedFlow<ProfileEvent> = _events.asSharedFlow()

    private var cooldownJob: Job? = null

    init {
        refreshProfile()
        viewModelScope.launch {
            realtimeRepository.events.collect { event ->
                // Сервер подтверждает или меняет режим (например, с другого устройства).
                if (event is WsEvent.UserStatusChanged && event.userId == profileRepository.cachedUser?.id) {
                    _dnd.value = event.status == UserStatus.DND
                }
                // Сервер держит «Не беспокоить» в памяти: после входа верна его версия.
                if (event is WsEvent.AuthSuccess) _dnd.value = event.user.status == UserStatus.DND
            }
        }
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
                _dnd.value = user.status == UserStatus.DND
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

    /**
     * Переключатель «Не беспокоить» (`set_dnd`). Выключение возвращает показ к автоматическому
     * присутствию: «В сети» или «Отошёл» вручную не выбираются (как на настольном клиенте).
     */
    fun setDnd(enabled: Boolean) {
        if (_dnd.value == enabled) return
        _dnd.value = enabled
        // Не ушло (нет связи) — переключатель возвращается: сервер режим не включил.
        if (!presenceController.setDnd(enabled)) {
            _dnd.value = !enabled
            _events.tryEmit(ProfileEvent.StatusSaveFailed)
        }
    }

    fun saveCustomStatus() {
        viewModelScope.launch {
            setSaving(true)
            try {
                val updatedText = _uiState.value.customStatusInput.trim()
                val updatedUser = profileRepository.updateCustomStatus(updatedText.ifBlank { null })
                showUser(updatedUser)
                // Свой статус коллеги видят сразу; присутствие и «Не беспокоить» не меняются.
                presenceController.publishCustomStatus(updatedText.ifBlank { null })
                _events.tryEmit(ProfileEvent.StatusSaved)
            } catch (error: SecureStorageUnavailableException) {
                showCachedUser()
                _storageError.value = error.message ?: "Secure storage is unavailable"
            } catch (_: Exception) {
                _events.tryEmit(ProfileEvent.StatusSaveFailed)
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
                // Unsent messages go first (the user agreed in the dialog); if they cannot be deleted,
                // nothing is signed out — they never silently stay for someone else.
                outgoing.discardForSignOut()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _logoutError.value = UNSENT_NOT_DELETED
                // Still signed in: the account goes on sending and receiving (its messages are back).
                outgoing.signOutAborted()
                return@launch
            }
            try {
                authRepository.logout()
            } catch (error: SecureStorageUnavailableException) {
                if (!authRepository.hasSessionToken) {
                    // The store refused the wipe, but the session is gone from memory and the store is
                    // marked unusable: this device IS signed out. Never say «выход отменён» then — the
                    // login screen says the secure storage is unavailable (review fix round 1).
                    onLoggedOut()
                    return@launch
                }
                _logoutError.value = error.message ?: "Secure storage is unavailable"
                // The session could not be cleared: whoever is still signed in goes on working.
                outgoing.signOutAborted()
                return@launch
            }
            onLoggedOut()
        }
    }
}
