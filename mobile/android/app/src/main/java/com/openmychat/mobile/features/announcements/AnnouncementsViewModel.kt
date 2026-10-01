package com.openmychat.mobile.features.announcements

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.Announcement
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class AnnouncementsViewModel(
    private val apiClient: ApiClient,
    private val webSocketClient: WebSocketClient
) : ViewModel() {

    private val _announcements = MutableStateFlow<List<Announcement>>(emptyList())
    val announcements: StateFlow<List<Announcement>> = _announcements.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _selectedAnnouncement = MutableStateFlow<Announcement?>(null)
    val selectedAnnouncement: StateFlow<Announcement?> = _selectedAnnouncement.asStateFlow()

    private val _isAcknowledging = MutableStateFlow(false)
    val isAcknowledging: StateFlow<Boolean> = _isAcknowledging.asStateFlow()

    init {
        loadAnnouncements()
        observeWebSocketEvents()
    }

    fun loadAnnouncements() {
        viewModelScope.launch {
            _isLoading.value = true
            try {
                _announcements.value = apiClient.getAnnouncements()
            } catch (_: Exception) {} finally {
                _isLoading.value = false
            }
        }
    }

    private fun observeWebSocketEvents() {
        viewModelScope.launch {
            webSocketClient.events.collect { event ->
                when (event) {
                    is WsEvent.NewAnnouncement -> {
                        if (_announcements.value.none { it.id == event.announcement.id }) {
                            _announcements.value = listOf(event.announcement) + _announcements.value
                        }
                    }
                    is WsEvent.AnnouncementAcknowledged -> {
                        val annIdLong = event.announcementId.toLongOrNull()
                        if (annIdLong != null) {
                            _announcements.value = _announcements.value.map { ann ->
                                if (ann.id == annIdLong) ann.copy(isConfirmed = true) else ann
                            }
                        }
                    }
                    else -> Unit
                }
            }
        }
    }

    fun selectAnnouncement(announcement: Announcement?) {
        _selectedAnnouncement.value = announcement
    }

    fun acknowledgeSelected() {
        val selected = _selectedAnnouncement.value ?: return
        viewModelScope.launch {
            _isAcknowledging.value = true
            try {
                apiClient.acknowledgeAnnouncement(selected.id)
                _announcements.value = _announcements.value.map { ann ->
                    if (ann.id == selected.id) ann.copy(isConfirmed = true) else ann
                }
                _selectedAnnouncement.value = null
            } catch (_: Exception) {} finally {
                _isAcknowledging.value = false
            }
        }
    }
}
