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
import com.openmychat.mobile.data.repository.AccountRepository
import com.openmychat.mobile.data.repository.ChatRepository
import com.openmychat.mobile.data.repository.UnavailableAccountRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import com.openmychat.mobile.data.realtime.resyncRequests
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

/** One-off messages for the snackbar. */
enum class ConversationsEvent { RefreshFailed }

/** Inbox search is by name only (brief: «Поиск по имени»): full name or login, trimmed, any case. */
fun filterByName(list: List<DirectConversation>, query: String): List<DirectConversation> {
    val q = query.trim()
    if (q.isEmpty()) return list
    return list.filter { it.fullName.contains(q, ignoreCase = true) || it.username?.contains(q, ignoreCase = true) == true }
}

fun filterChannelsByName(list: List<Channel>, query: String): List<Channel> {
    val q = query.trim().removePrefix("#")
    if (q.isEmpty()) return list
    return list.filter { it.name.contains(q, ignoreCase = true) }
}

@HiltViewModel
class ConversationsViewModel @Inject constructor(
    private val chatRepository: ChatRepository,
    private val realtimeRepository: RealtimeRepository,
    private val sessionRepository: SessionRepository,
    private val activeConversations: ActiveConversationRegistry,
    /** Прочитано на другом устройстве (conversation_read, push read) — обнулить счётчик переписки. */
    private val readElsewhere: com.openmychat.mobile.data.notifications.ConversationReadBus =
        com.openmychat.mobile.data.notifications.ConversationReadBus(),
    /** Процесс вышел на передний план: список догружаем (как после переподключения). */
    private val foreground: com.openmychat.mobile.data.realtime.ForegroundSignal = com.openmychat.mobile.data.realtime.ForegroundSignal(),
    /** Blocked people's direct chats leave the list (contracts/registration.md §4). */
    private val account: AccountRepository = UnavailableAccountRepository
) : ViewModel() {

    val currentUserId: Long? get() = sessionRepository.currentUserId

    /** Realtime link status, for a "connecting" hint in the list header. */
    val connectionState: StateFlow<ConnectionState> = realtimeRepository.connectionState

    private val _selectedTab = MutableStateFlow(ConversationsTab.CHATS)
    val selectedTab: StateFlow<ConversationsTab> = _selectedTab.asStateFlow()

    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()

    private val _uiState = MutableStateFlow<ConversationsUiState>(ConversationsUiState.Loading)
    val uiState: StateFlow<ConversationsUiState> = _uiState.asStateFlow()

    /** Pull-to-refresh in progress (the list stays on screen). */
    private val _isRefreshing = MutableStateFlow(false)
    val isRefreshing: StateFlow<Boolean> = _isRefreshing.asStateFlow()

    private val _events = MutableSharedFlow<ConversationsEvent>(extraBufferCapacity = 4)
    val events: SharedFlow<ConversationsEvent> = _events.asSharedFlow()

    /** Conversations where someone is typing right now; each entry expires after 3 s of silence. */
    private val _typing = MutableStateFlow<Set<ConversationRef>>(emptySet())
    val typing: StateFlow<Set<ConversationRef>> = _typing.asStateFlow()
    private val typingTimeouts = mutableMapOf<ConversationRef, Job>()

    /** The conversation open next to the list (wide windows), highlighted in the list. */
    val openConversation: StateFlow<ConversationRef?> = activeConversations.active

    /** Pull-to-refresh: reloads without replacing the list; a failure keeps the list and reports it. */
    fun refresh() {
        if (_isRefreshing.value) return
        _isRefreshing.value = true
        loadData(showLoading = false)
    }

    init {
        loadData()
        observeBlocks()
        observeWebSocketEvents()
        observeOpenConversation()
        resyncAfterReconnect()
    }

    private fun blockedIds(): Set<Long> = account.blocked.value.mapTo(HashSet()) { it.id }

    /**
     * A block hides that person's direct chat at once; the list is then reloaded, since the server now
     * hides (or, after an unblock, shows again) their messages (contracts/registration.md §4).
     */
    private fun observeBlocks() {
        viewModelScope.launch {
            account.blocked.map { list -> list.mapTo(HashSet()) { it.id } }.distinctUntilChanged().drop(1).collect { hidden ->
                updateContent { it.copy(directConversations = it.directConversations.filterNot { conv -> conv.userId in hidden }) }
                loadData(showLoading = false)
            }
        }
    }

    /** After a drop or on foreground entry the list is reloaded once: gap messages, previews and counters catch up. */
    private fun resyncAfterReconnect() {
        viewModelScope.launch {
            connectionState.resyncRequests(foreground.entered).collect { loadData(showLoading = false) }
        }
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
                val chats = chatRepository.directConversations().let { all ->
                    val hidden = blockedIds()
                    if (hidden.isEmpty()) all else all.filterNot { it.userId in hidden }
                }
                val channels = chatRepository.channels()
                serverInfo.join()
                _uiState.value = storageError?.let(ConversationsUiState::Error)
                    ?: ConversationsUiState.Content(chats, channels).withoutUnreadFor(activeConversations.active.value)
            } catch (e: Exception) {
                if (!showLoading && _uiState.value is ConversationsUiState.Content) {
                    _events.tryEmit(ConversationsEvent.RefreshFailed)
                } else {
                    _uiState.value = ConversationsUiState.Error(e.message ?: "Ошибка загрузки списка чатов")
                }
            } finally {
                _isRefreshing.value = false
            }
        }
    }

    private inline fun updateContent(transform: (ConversationsUiState.Content) -> ConversationsUiState.Content) {
        _uiState.update { state -> if (state is ConversationsUiState.Content) transform(state) else state }
    }

    private fun observeOpenConversation() {
        viewModelScope.launch {
            readElsewhere.reads.collect { read -> updateContent { it.withoutUnreadFor(read) } }
        }
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

    private fun typingRefOf(type: ConversationType, userId: Long, targetId: Long): ConversationRef? {
        if (userId == sessionRepository.currentUserId) return null
        return if (type == ConversationType.DIRECT) ConversationRef(ConversationType.DIRECT, userId)
        else ConversationRef(ConversationType.CHANNEL, targetId)
    }

    private fun onTyping(event: WsEvent.UserTyping) {
        val ref = typingRefOf(ConversationType.fromValue(event.conversationType), event.userId, event.targetId) ?: return
        if (!event.isTyping) return stopTyping(ref)
        _typing.update { it + ref }
        typingTimeouts.remove(ref)?.cancel()
        typingTimeouts[ref] = viewModelScope.launch {
            delay(TYPING_TIMEOUT_MILLIS)
            stopTyping(ref)
        }
    }

    private fun stopTyping(ref: ConversationRef) {
        typingTimeouts.remove(ref)?.cancel()
        _typing.update { it - ref }
    }

    private fun observeWebSocketEvents() {
        viewModelScope.launch {
            realtimeRepository.events.collect { event ->
                when (event) {
                    is WsEvent.NewMessage -> {
                        onNewMessage(event.message)
                        // A message ends the sender's typing in that row.
                        typingRefOf(event.message.conversationType, event.message.senderId, event.message.targetId)
                            ?.let { stopTyping(it) }
                    }
                    is WsEvent.UserTyping -> onTyping(event)
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

    private companion object {
        /** Same as the chat header: typing without a fresh signal ends after 3 s. */
        const val TYPING_TIMEOUT_MILLIS = 3_000L


    }
}
