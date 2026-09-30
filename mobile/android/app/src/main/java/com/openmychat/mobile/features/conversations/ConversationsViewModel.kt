package com.openmychat.mobile.features.conversations

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.model.UserStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class ConversationsTab {
    CHATS,
    CHANNELS
}

class ConversationsViewModel(
    private val apiClient: ApiClient,
    private val webSocketClient: WebSocketClient,
    val sessionManager: SessionManager
) : ViewModel() {

    private val _selectedTab = MutableStateFlow(ConversationsTab.CHATS)
    val selectedTab: StateFlow<ConversationsTab> = _selectedTab.asStateFlow()

    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()

    private val _directConversations = MutableStateFlow<List<DirectConversation>>(emptyList())
    val directConversations: StateFlow<List<DirectConversation>> = _directConversations.asStateFlow()

    private val _channels = MutableStateFlow<List<Channel>>(emptyList())
    val channels: StateFlow<List<Channel>> = _channels.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

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
            _isLoading.value = true
            _error.value = null
            try {
                // Fetch server info for edit/delete windows
                launch { try { apiClient.getServerInfo() } catch (_: Exception) {} }

                val chats = apiClient.getDirectConversations()
                val chs = apiClient.getChannels()
                _directConversations.value = chats
                _channels.value = chs
            } catch (e: Exception) {
                _error.value = e.message ?: "Ошибка загрузки списка чатов"
            } finally {
                _isLoading.value = false
            }
        }
    }

    private fun observeWebSocketEvents() {
        viewModelScope.launch {
            webSocketClient.events.collect { event ->
                when (event) {
                    is WsEvent.NewMessage -> {
                        val msg = event.message
                        if (msg.conversationType == ConversationType.DIRECT) {
                            val currentUserId = sessionManager.currentUser?.id
                            val peerId = if (msg.senderId == currentUserId) msg.targetId else msg.senderId

                            _directConversations.value = _directConversations.value.map { conv ->
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
                            }
                        } else if (msg.conversationType == ConversationType.CHANNEL) {
                            _channels.value = _channels.value.map { ch ->
                                if (ch.id == msg.targetId) {
                                    ch.copy(
                                        lastMessageText = msg.text,
                                        lastMessageTime = msg.createdAt,
                                        unreadCount = ch.unreadCount + 1
                                    )
                                } else ch
                            }
                        }
                    }
                    is WsEvent.UserStatusChanged -> {
                        _directConversations.value = _directConversations.value.map { conv ->
                            if (conv.userId == event.userId) {
                                conv.copy(
                                    status = event.status,
                                    customStatus = event.customStatus ?: conv.customStatus
                                )
                            } else conv
                        }
                    }
                    is WsEvent.ChannelCreated -> {
                        if (_channels.value.none { it.id == event.channel.id }) {
                            _channels.value = listOf(event.channel) + _channels.value
                        }
                    }
                    is WsEvent.ChannelDeleted -> {
                        _channels.value = _channels.value.filter { it.id != event.channelId }
                    }
                    else -> Unit
                }
            }
        }
    }
}
