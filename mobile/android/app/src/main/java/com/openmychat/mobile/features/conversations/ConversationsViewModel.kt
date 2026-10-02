package com.openmychat.mobile.features.conversations

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.data.realtime.ConversationRef
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
    private val sessionRepository: SessionRepository,
    private val activeConversations: ActiveConversationRegistry
) : ViewModel() {

    /** Realtime link status, for a "connecting" hint in the list header. */
    val connectionState: StateFlow<ConnectionState> = realtimeRepository.connectionState

    private val _selectedTab = MutableStateFlow(ConversationsTab.CHATS)
    val selectedTab: StateFlow<ConversationsTab> = _selectedTab.asStateFlow()

    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()

    private val _uiState = MutableStateFlow<ConversationsUiState>(ConversationsUiState.Loading)
    val uiState: StateFlow<ConversationsUiState> = _uiState.asStateFlow()

    init {
        loadData()
        observeWebSocketEvents()
        observeOpenConversation()
    }

    fun selectTab(tab: ConversationsTab) {
        _selectedTab.value = tab
    }

    fun setSearchQuery(query: String) {
        _searchQuery.value = query
    }

    /** Reloads both lists. [showLoading] = false keeps the current list on screen while refreshing. */
    fun loadData(showLoading: Boolean = true) {
        viewModelScope.launch {
            if (showLoading || _uiState.value !is ConversationsUiState.Content) {
                _uiState.value = ConversationsUiState.Loading
            }
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
                    ?: ConversationsUiState.Content(chats, channels).withoutUnreadFor(activeConversations.active.value)
            } catch (e: Exception) {
                _uiState.value = ConversationsUiState.Error(e.message ?: "Ошибка загрузки списка чатов")
            }
        }
    }

    private inline fun updateContent(transform: (ConversationsUiState.Content) -> ConversationsUiState.Content) {
        _uiState.update { state -> if (state is ConversationsUiState.Content) transform(state) else state }
    }

    private fun observeOpenConversation() {
        viewModelScope.launch {
            activeConversations.active.collect { open ->
                // The chat marks its messages read when it opens; mirror that in the list.
                updateContent { it.withoutUnreadFor(open) }
            }
        }
    }

    private fun ConversationsUiState.Content.withoutUnreadFor(open: ConversationRef?): ConversationsUiState.Content =
        when (open?.type) {
            ConversationType.DIRECT -> copy(directConversations = directConversations.map { conv ->
                if (conv.userId == open.targetId && conv.unreadCount != 0) conv.copy(unreadCount = 0) else conv
            })
            ConversationType.CHANNEL -> copy(channels = channels.map { ch ->
                if (ch.id == open.targetId && ch.unreadCount != 0) ch.copy(unreadCount = 0) else ch
            })
            null -> this
        }

    private fun onNewMessage(msg: Message) {
        val currentUserId = sessionRepository.currentUserId
        val isOwn = msg.senderId == currentUserId
        val open = activeConversations.active.value
        if (msg.conversationType == ConversationType.DIRECT) {
            val peerId = if (isOwn) msg.targetId else msg.senderId
            val isOpen = open == ConversationRef(ConversationType.DIRECT, peerId)
            val content = _uiState.value as? ConversationsUiState.Content
            if (content != null && content.directConversations.none { it.userId == peerId }) {
                // First message of a new dialog: the list does not know this peer yet.
                loadData(showLoading = false)
                return
            }
            updateContent { state ->
                state.copy(directConversations = state.directConversations.map { conv ->
                    if (conv.userId != peerId) return@map conv
                    conv.copy(
                        lastMessageId = msg.id,
                        lastMessageText = msg.text,
                        lastMessageTime = msg.createdAt,
                        lastMessageSenderId = msg.senderId,
                        unreadCount = if (!isOwn && !isOpen) conv.unreadCount + 1 else conv.unreadCount
                    )
                })
            }
        } else {
            val isOpen = open == ConversationRef(ConversationType.CHANNEL, msg.targetId)
            updateContent { state ->
                state.copy(channels = state.channels.map { ch ->
                    if (ch.id != msg.targetId) return@map ch
                    ch.copy(
                        lastMessageText = msg.text,
                        lastMessageTime = msg.createdAt,
                        unreadCount = if (!isOwn && !isOpen) ch.unreadCount + 1 else ch.unreadCount
                    )
                })
            }
        }
    }

    private fun observeWebSocketEvents() {
        viewModelScope.launch {
            realtimeRepository.events.collect { event ->
                when (event) {
                    is WsEvent.NewMessage -> onNewMessage(event.message)
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
