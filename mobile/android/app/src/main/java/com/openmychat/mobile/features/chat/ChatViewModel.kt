package com.openmychat.mobile.features.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.core.util.MessageWindowValidator
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DeliveryStatus
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.data.realtime.ConversationRef
import com.openmychat.mobile.data.repository.ChatRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedFactory
import dagger.assisted.AssistedInject
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Message history state of a conversation; composer chrome (typing, editing, wake) is separate. */
sealed interface ChatUiState {
    data object Loading : ChatUiState
    data class Error(val message: String) : ChatUiState
    data class Content(val messages: List<Message>) : ChatUiState
}

@HiltViewModel(assistedFactory = ChatViewModel.Factory::class)
class ChatViewModel @AssistedInject constructor(
    @Assisted val conversationType: ConversationType,
    @Assisted("target") val targetId: Long,
    private val chatRepository: ChatRepository,
    private val realtimeRepository: RealtimeRepository,
    private val sessionRepository: SessionRepository,
    private val activeConversations: ActiveConversationRegistry,
    private val historyCache: ChatHistoryCache,
    /** Открыть на этом сообщении (переход из поиска). */
    @Assisted("focus") focusMessageId: Long? = null
) : ViewModel() {

    @AssistedFactory
    interface Factory {
        fun create(
            conversationType: ConversationType,
            @Assisted("target") targetId: Long,
            @Assisted("focus") focusMessageId: Long?
        ): ChatViewModel
    }

    private val _uiState = MutableStateFlow<ChatUiState>(ChatUiState.Loading)
    val uiState: StateFlow<ChatUiState> = _uiState.asStateFlow()

    /** Realtime link status for the connection banner. */
    val connectionState: StateFlow<ConnectionState> = realtimeRepository.connectionState

    /** Live presence of the peer in a direct chat; null until the server reports a change. */
    private val _peerStatus = MutableStateFlow<UserStatus?>(null)
    val peerStatus: StateFlow<UserStatus?> = _peerStatus.asStateFlow()

    private val _typingUser = MutableStateFlow<String?>(null)
    val typingUser: StateFlow<String?> = _typingUser.asStateFlow()

    private val _wakeCooldownSeconds = MutableStateFlow(0)
    val wakeCooldownSeconds: StateFlow<Int> = _wakeCooldownSeconds.asStateFlow()

    private val _refreshFailed = MutableStateFlow(false)

    /** The server history could not be loaded while a cached one is shown. */
    val refreshFailed: StateFlow<Boolean> = _refreshFailed.asStateFlow()

    private val _editingMessage = MutableStateFlow<Message?>(null)
    val editingMessage: StateFlow<Message?> = _editingMessage.asStateFlow()

    /** Сообщение, к которому прокрутить и которое подсветить; null — после показа или без перехода. */
    private val _focus = MutableStateFlow<Long?>(null)
    val focus: StateFlow<Long?> = _focus.asStateFlow()

    /** Найденное сообщение слишком давнее: чат открыт на последних сообщениях. */
    private val _jumpUnavailable = MutableStateFlow(false)
    val jumpUnavailable: StateFlow<Boolean> = _jumpUnavailable.asStateFlow()

    /** Переход ещё не выполнен. */
    private var pendingFocus: Long? = focusMessageId

    /** История собрана вокруг этого сообщения: обновление собирает её так же, без дыры. */
    private var windowAnchor: Long? = null

    private val conversation = ConversationRef(conversationType, targetId)

    /** True while the chat is on screen (resumed); only then are messages marked read. */
    private var isVisible = false

    private var typingResetJob: Job? = null
    private var wakeTimerJob: Job? = null

    val currentUserId: Long get() = sessionRepository.currentUserId ?: 0L

    private val messages: List<Message>
        get() = (_uiState.value as? ChatUiState.Content)?.messages.orEmpty()

    init {
        // A chat opened before shows its last history at once and refreshes underneath.
        historyCache.get(currentUserId, conversation)?.let { _uiState.value = ChatUiState.Content(it) }
        viewModelScope.launch {
            _uiState.collect { state -> if (state is ChatUiState.Content) historyCache.put(currentUserId, conversation, state.messages) }
        }
        loadMessages()
        observeWebSocketEvents()
    }

    /** Called by the screen on resume/pause. A chat kept in the back stack must not read messages. */
    fun onVisibilityChanged(visible: Boolean) {
        if (visible == isVisible) return
        isVisible = visible
        if (visible) {
            activeConversations.enter(conversation)
            markAsRead()
        } else {
            activeConversations.leave(conversation)
        }
    }

    override fun onCleared() {
        activeConversations.leave(conversation)
        super.onCleared()
    }

    /** Экран прокрутил к сообщению и подсветил его. */
    fun onFocusShown() {
        _focus.value = null
    }

    fun loadMessages() {
        viewModelScope.launch {
            if (_uiState.value !is ChatUiState.Content) _uiState.value = ChatUiState.Loading
            // What was already shown (a cached history) is replaced by the server, not merged.
            val shownBefore = (_uiState.value as? ChatUiState.Content)?.messages.orEmpty().mapTo(HashSet()) { it.id }
            _refreshFailed.value = false
            try {
                val jump = pendingFocus
                val anchor = jump ?: windowAnchor
                val window = anchor?.let { chatRepository.messagesAround(conversationType, targetId, it) }
                if (jump != null) {
                    pendingFocus = null
                    if (window != null) windowAnchor = jump else _jumpUnavailable.value = true
                }
                val history = window ?: chatRepository.messages(conversationType, targetId)
                _uiState.update { state ->
                    // Keep realtime messages that arrived while the history request was in flight.
                    val live = (state as? ChatUiState.Content)?.messages.orEmpty()
                    val historyIds = history.mapTo(HashSet()) { it.id }
                    ChatUiState.Content(history + live.filter { it.id !in historyIds && it.id !in shownBefore })
                }
                if (jump != null && window != null) _focus.value = jump
            } catch (e: Exception) {
                // A cached history stays on screen; the screen says it could not be refreshed.
                if (_uiState.value is ChatUiState.Content) _refreshFailed.value = true
                if (_uiState.value !is ChatUiState.Content) {
                    _uiState.value = ChatUiState.Error(e.message ?: "Не удалось загрузить сообщения")
                }
            }
        }
    }

    private fun updateMessages(transform: (List<Message>) -> List<Message>) {
        _uiState.update { state ->
            when (state) {
                is ChatUiState.Content -> state.copy(messages = transform(state.messages))
                else -> state
            }
        }
    }

    private fun markAsRead() {
        realtimeRepository.markRead(conversationType, targetId)
    }

    private fun observeWebSocketEvents() {
        viewModelScope.launch {
            realtimeRepository.events.collect { event ->
                when (event) {
                    is WsEvent.NewMessage -> {
                        val msg = event.message
                        val matches = if (conversationType == ConversationType.DIRECT) {
                            (msg.conversationType == ConversationType.DIRECT) &&
                                ((msg.senderId == targetId && msg.targetId == currentUserId) ||
                                    (msg.senderId == currentUserId && msg.targetId == targetId))
                        } else {
                            (msg.conversationType == ConversationType.CHANNEL) && (msg.targetId == targetId)
                        }

                        if (matches && messages.none { it.id == msg.id }) {
                            _uiState.update { state ->
                                when (state) {
                                    is ChatUiState.Content -> state.copy(messages = state.messages + msg)
                                    else -> ChatUiState.Content(listOf(msg))
                                }
                            }
                            if (isVisible && msg.senderId != currentUserId) markAsRead()
                        }
                    }
                    is WsEvent.MessageStatusUpdated -> updateMessages { list ->
                        list.map { msg ->
                            if (msg.id == event.messageId) {
                                msg.copy(deliveryStatus = DeliveryStatus.fromValue(event.status))
                            } else msg
                        }
                    }
                    is WsEvent.MessagesRead -> {
                        if (conversationType == ConversationType.DIRECT && event.byUserId == targetId) {
                            val idSet = event.messageIds.toSet()
                            updateMessages { list ->
                                list.map { msg ->
                                    if (idSet.contains(msg.id)) msg.copy(deliveryStatus = DeliveryStatus.READ) else msg
                                }
                            }
                        }
                    }
                    is WsEvent.MessageUpdated -> updateMessages { list ->
                        list.map { msg ->
                            if (msg.id == event.messageId) msg.copy(text = event.text, updatedAt = event.updatedAt) else msg
                        }
                    }
                    is WsEvent.MessageDeleted -> {
                        val matches = if (conversationType == ConversationType.DIRECT) {
                            // target_id is the message's recipient: the peer for my messages, me for theirs.
                            event.conversationType == "direct" &&
                                (event.targetId == targetId || event.targetId == currentUserId)
                        } else {
                            event.conversationType == "channel" && event.targetId == targetId
                        }
                        if (matches) {
                            updateMessages { list -> list.filter { it.id != event.messageId } }
                        }
                    }
                    is WsEvent.UserTyping -> {
                        val matches = if (conversationType == ConversationType.DIRECT) {
                            event.conversationType == "direct" && event.userId == targetId
                        } else {
                            event.conversationType == "channel" && event.targetId == targetId && event.userId != currentUserId
                        }

                        if (matches) {
                            if (event.isTyping) {
                                _typingUser.value = event.userName.ifBlank { "Собеседник" }
                                typingResetJob?.cancel()
                                typingResetJob = launch {
                                    delay(3000)
                                    _typingUser.value = null
                                }
                            } else {
                                _typingUser.value = null
                            }
                        }
                    }
                    is WsEvent.UserStatusChanged -> {
                        if (conversationType == ConversationType.DIRECT && event.userId == targetId) {
                            _peerStatus.value = event.status
                        }
                    }
                    is WsEvent.WakeSent -> {
                        if (event.targetUserId == targetId) {
                            val remainingSeconds = ((event.retryAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0).toInt()
                            startWakeCooldown(remainingSeconds.coerceAtLeast(60))
                        }
                    }
                    else -> Unit
                }
            }
        }
    }

    fun sendMessage(text: String) {
        if (text.isBlank()) return
        val editing = _editingMessage.value
        if (editing != null) {
            realtimeRepository.editMessage(editing.id, text.trim())
            _editingMessage.value = null
        } else {
            realtimeRepository.sendMessage(conversationType, targetId, text.trim())
        }
    }

    fun startEditing(message: Message) {
        _editingMessage.value = message
    }

    fun cancelEditing() {
        _editingMessage.value = null
    }

    fun deleteMessage(message: Message) {
        realtimeRepository.deleteMessage(message.id)
    }

    fun onTyping(isTyping: Boolean) {
        realtimeRepository.sendTyping(conversationType, targetId, isTyping)
    }

    fun sendWake() {
        if (_wakeCooldownSeconds.value > 0) return
        realtimeRepository.sendWake(targetId)
        startWakeCooldown(60)
    }

    private fun startWakeCooldown(seconds: Int) {
        wakeTimerJob?.cancel()
        _wakeCooldownSeconds.value = seconds
        wakeTimerJob = viewModelScope.launch {
            while (_wakeCooldownSeconds.value > 0) {
                delay(1000)
                _wakeCooldownSeconds.value -= 1
            }
        }
    }

    fun canEditMessage(message: Message): Boolean {
        if (message.senderId != currentUserId) return false
        if (message.isDeleted) return false
        if (message.type != MessageType.TEXT) return false
        return MessageWindowValidator.canEditOrDelete(
            createdAtIso = message.createdAt,
            windowMinutesStr = sessionRepository.messageEditWindowMinutes,
            isSuperAdmin = false,
            isDelete = false
        )
    }

    fun canDeleteMessage(message: Message): Boolean {
        val isAuthor = message.senderId == currentUserId
        val isAdmin = sessionRepository.isAdmin
        if (!isAuthor && !isAdmin) return false

        return MessageWindowValidator.canEditOrDelete(
            createdAtIso = message.createdAt,
            windowMinutesStr = sessionRepository.messageDeleteWindowMinutes,
            isSuperAdmin = isAdmin,
            isDelete = true
        )
    }
}
