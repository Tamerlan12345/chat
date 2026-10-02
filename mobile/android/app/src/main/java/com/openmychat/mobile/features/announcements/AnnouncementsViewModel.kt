package com.openmychat.mobile.features.announcements

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.Announcement
import com.openmychat.mobile.data.repository.AnnouncementsRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
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

@HiltViewModel
class AnnouncementsViewModel @Inject constructor(
    private val announcementsRepository: AnnouncementsRepository,
    private val realtimeRepository: RealtimeRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow<AnnouncementsUiState>(AnnouncementsUiState.Loading)
    val uiState: StateFlow<AnnouncementsUiState> = _uiState.asStateFlow()

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
                        selected = null
                    )
                }
            } catch (_: Exception) {
            } finally {
                updateContent { it.copy(isAcknowledging = false) }
            }
        }
    }
}
