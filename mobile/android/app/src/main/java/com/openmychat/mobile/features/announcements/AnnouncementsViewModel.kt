package com.openmychat.mobile.features.announcements

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.Announcement
import com.openmychat.mobile.data.repository.AnnouncementsRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface AnnouncementsUiState {
    data object Loading : AnnouncementsUiState
    data class Error(val message: String) : AnnouncementsUiState
    data class Content(
        val announcements: List<Announcement>,
        val isRefreshing: Boolean = false,
        val selected: Announcement? = null,
        val isAcknowledging: Boolean = false
    ) : AnnouncementsUiState
}

/** One-off outcomes for the snackbar and haptics. */
enum class AnnouncementsEvent { RefreshFailed, Acknowledged, AcknowledgeFailed }

@HiltViewModel
class AnnouncementsViewModel @Inject constructor(
    private val announcementsRepository: AnnouncementsRepository,
    private val realtimeRepository: RealtimeRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow<AnnouncementsUiState>(AnnouncementsUiState.Loading)
    val uiState: StateFlow<AnnouncementsUiState> = _uiState.asStateFlow()

    /** Realtime link status for the connection banner. */
    val connectionState: StateFlow<ConnectionState> = realtimeRepository.connectionState

    private val _events = MutableSharedFlow<AnnouncementsEvent>(extraBufferCapacity = 4)
    val events: SharedFlow<AnnouncementsEvent> = _events.asSharedFlow()

    init {
        loadAnnouncements()
        observeWebSocketEvents()
    }

    private inline fun updateContent(transform: (AnnouncementsUiState.Content) -> AnnouncementsUiState.Content) {
        _uiState.update { state -> if (state is AnnouncementsUiState.Content) transform(state) else state }
    }

    fun loadAnnouncements() {
        viewModelScope.launch {
            val previous = _uiState.value as? AnnouncementsUiState.Content
            if (previous == null) {
                _uiState.value = AnnouncementsUiState.Loading
            } else {
                updateContent { it.copy(isRefreshing = true) }
            }
            try {
                val announcements = announcementsRepository.announcements()
                _uiState.update { state ->
                    (state as? AnnouncementsUiState.Content)?.copy(announcements = announcements, isRefreshing = false)
                        ?: AnnouncementsUiState.Content(announcements)
                }
            } catch (e: Exception) {
                if (previous == null) {
                    _uiState.value = AnnouncementsUiState.Error(e.message ?: "Не удалось загрузить объявления")
                } else {
                    updateContent { it.copy(isRefreshing = false) }
                    _events.tryEmit(AnnouncementsEvent.RefreshFailed)
                }
            }
        }
    }

    private fun observeWebSocketEvents() {
        viewModelScope.launch {
            realtimeRepository.events.collect { event ->
                when (event) {
                    is WsEvent.NewAnnouncement -> updateContent { content ->
                        if (content.announcements.any { it.id == event.announcement.id }) content
                        else content.copy(announcements = listOf(event.announcement) + content.announcements)
                    }
                    is WsEvent.AnnouncementAcknowledged -> {
                        val annIdLong = event.announcementId.toLongOrNull() ?: return@collect
                        updateContent { content ->
                            content.copy(announcements = content.announcements.map { ann ->
                                if (ann.id == annIdLong) ann.copy(isConfirmed = true) else ann
                            })
                        }
                    }
                    else -> Unit
                }
            }
        }
    }

    fun selectAnnouncement(announcement: Announcement?) {
        updateContent { it.copy(selected = announcement) }
    }

    fun acknowledgeSelected() {
        val selected = (_uiState.value as? AnnouncementsUiState.Content)?.selected ?: return
        viewModelScope.launch {
            updateContent { it.copy(isAcknowledging = true) }
            try {
                announcementsRepository.acknowledge(selected.id)
                updateContent { content ->
                    content.copy(
                        announcements = content.announcements.map { ann ->
                            if (ann.id == selected.id) ann.copy(isConfirmed = true) else ann
                        },
                        // The open sheet turns into its success state; the user closes it.
                        selected = content.selected?.takeIf { it.id == selected.id }?.copy(isConfirmed = true) ?: content.selected
                    )
                }
                _events.tryEmit(AnnouncementsEvent.Acknowledged)
            } catch (_: Exception) {
                // The sheet stays open with the button enabled, so the user can try again.
                _events.tryEmit(AnnouncementsEvent.AcknowledgeFailed)
            } finally {
                updateContent { it.copy(isAcknowledging = false) }
            }
        }
    }
}
