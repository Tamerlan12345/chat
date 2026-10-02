package com.openmychat.mobile.features.conversations

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.repository.ChatRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class ConversationsTab {
    CHATS,
    CHANNELS
}

sealed interface ConversationsUiState {
    data object Loading : ConversationsUiState
    data class Error(val message: String) : ConversationsUiState
    data class Content(
        val directConversations: List<DirectConversation>,
        val channels: List<Channel>
    ) : ConversationsUiState
}

@HiltViewModel
class ConversationsViewModel @Inject constructor(
    private val chatRepository: ChatRepository,
    private val realtimeRepository: RealtimeRepository,
    private val sessionRepository: SessionRepository
) : ViewModel() {

    private val _selectedTab = MutableStateFlow(ConversationsTab.CHATS)
    val selectedTab: StateFlow<ConversationsTab> = _selectedTab.asStateFlow()

    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()

    private val _uiState = MutableStateFlow<ConversationsUiState>(ConversationsUiState.Loading)
    val uiState: StateFlow<ConversationsUiState> = _uiState.asStateFlow()

    init {
        loadData()
        observeWebSocketEvents()
    }

    fun selectTab(tab: ConversationsTab) {
        _selectedTab.value = tab
    }

    fun setSearchQuery(query: String) {
        _searchQuery.value = query
    }

    fun loadData() {
        viewModelScope.launch {
            _uiState.value = ConversationsUiState.Loading
            var storageError: String? = null
            // Server-info caching is non-critical; the primary data request continues.
            val serverInfo = launch {
                try {
                    chatRepository.refreshServerInfo()
                } catch (error: SecureStorageUnavailableException) {
                    storageError = error.message ?: "Secure storage is unavailable"
                } catch (_: Exception) {
                }
            }
            try {
                val chats = chatRepository.directConversations()
                val channels = chatRepository.channels()
                serverInfo.join()
                _uiState.value = storageError?.let(ConversationsUiState::Error)
                    ?: ConversationsUiState.Content(chats, channels)
            } catch (e: Exception) {
                _uiState.value = ConversationsUiState.Error(e.message ?: "Ошибка загрузки списка чатов")
            }
        }
    }

    private inline fun updateContent(transform: (ConversationsUiState.Content) -> ConversationsUiState.Content) {
        _uiState.update { state -> if (state is ConversationsUiState.Content) transform(state) else state }
    }

    private fun observeWebSocketEvents() {
        viewModelScope.launch {
            realtimeRepository.events.collect { event ->
                when (event) {
                    is WsEvent.NewMessage -> {
                        val msg = event.message
                        if (msg.conversationType == ConversationType.DIRECT) {
                            val currentUserId = sessionRepository.currentUserId
                            val peerId = if (msg.senderId == currentUserId) msg.targetId else msg.senderId
                            updateContent { content ->
                                content.copy(directConversations = content.directConversations.map { conv ->
                                    if (conv.userId == peerId) {
                                        val isIncoming = msg.senderId != currentUserId
                                        conv.copy(
                                            lastMessageId = msg.id,
                                            lastMessageText = msg.text,
                                            lastMessageTime = msg.createdAt,
                                            lastMessageSenderId = msg.senderId,
                                            unreadCount = if (isIncoming) conv.unreadCount + 1 else conv.unreadCount
                                        )
                                    } else conv
                                })
                            }
                        } else if (msg.conversationType == ConversationType.CHANNEL) {
                            updateContent { content ->
                                content.copy(channels = content.channels.map { ch ->
                                    if (ch.id == msg.targetId) {
                                        ch.copy(
                                            lastMessageText = msg.text,
                                            lastMessageTime = msg.createdAt,
                                            unreadCount = ch.unreadCount + 1
                                        )
                                    } else ch
                                })
                            }
                        }
                    }
                    is WsEvent.UserStatusChanged -> updateContent { content ->
                        content.copy(directConversations = content.directConversations.map { conv ->
                            if (conv.userId == event.userId) {
                                conv.copy(
                                    status = event.status,
                                    customStatus = event.customStatus ?: conv.customStatus
                                )
                            } else conv
                        })
                    }
                    is WsEvent.ChannelCreated -> updateContent { content ->
                        if (content.channels.any { it.id == event.channel.id }) content
                        else content.copy(channels = listOf(event.channel) + content.channels)
                    }
                    is WsEvent.ChannelDeleted -> updateContent { content ->
                        content.copy(channels = content.channels.filter { it.id != event.channelId })
                    }
                    else -> Unit
                }
            }
        }
    }
}
