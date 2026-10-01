package com.openmychat.mobile.features.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.core.util.MessageWindowValidator
import com.openmychat.mobile.data.model.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class ChatViewModel(
    val conversationType: ConversationType,
    val targetId: Long,
    private val apiClient: ApiClient,
    private val webSocketClient: WebSocketClient,
    val sessionManager: SessionManager
) : ViewModel() {

    private val _messages = MutableStateFlow<List<Message>>(emptyList())
    val messages: StateFlow<List<Message>> = _messages.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _typingUser = MutableStateFlow<String?>(null)
    val typingUser: StateFlow<String?> = _typingUser.asStateFlow()

    private val _wakeCooldownSeconds = MutableStateFlow(0)
    val wakeCooldownSeconds: StateFlow<Int> = _wakeCooldownSeconds.asStateFlow()

    private val _editingMessage = MutableStateFlow<Message?>(null)
    val editingMessage: StateFlow<Message?> = _editingMessage.asStateFlow()

    private var typingResetJob: Job? = null
    private var wakeTimerJob: Job? = null

    val currentUserId: Long get() = sessionManager.currentUser?.id ?: 0L

    init {
        loadMessages()
        observeWebSocketEvents()
        markAsRead()
    }

    fun loadMessages() {
        viewModelScope.launch {
            _isLoading.value = true
            try {
                val list = if (conversationType == ConversationType.DIRECT) {
                    apiClient.getDirectMessages(targetId)
                } else {
                    apiClient.getChannelMessages(targetId)
                }
                _messages.value = list
            } catch (_: Exception) {} finally {
                _isLoading.value = false
            }
        }
    }

    private fun markAsRead() {
        webSocketClient.markRead(conversationType, targetId)
    }

    private fun observeWebSocketEvents() {
        viewModelScope.launch {
            webSocketClient.events.collect { event ->
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

                        if (matches) {
                            if (_messages.value.none { it.id == msg.id }) {
                                _messages.value = _messages.value + msg
                                markAsRead()
                            }
                        }
                    }
                    is WsEvent.MessageStatusUpdated -> {
                        _messages.value = _messages.value.map { msg ->
                            if (msg.id == event.messageId) {
                                msg.copy(deliveryStatus = DeliveryStatus.fromValue(event.status))
                            } else msg
                        }
                    }
                    is WsEvent.MessagesRead -> {
                        if (conversationType == ConversationType.DIRECT && event.byUserId == targetId) {
                            val idSet = event.messageIds.toSet()
                            _messages.value = _messages.value.map { msg ->
                                if (idSet.contains(msg.id)) {
                                    msg.copy(deliveryStatus = DeliveryStatus.READ)
                                } else msg
                            }
                        }
                    }
                    is WsEvent.MessageUpdated -> {
                        _messages.value = _messages.value.map { msg ->
                            if (msg.id == event.messageId) {
                                msg.copy(text = event.text, updatedAt = event.updatedAt)
                            } else msg
                        }
                    }
                    is WsEvent.MessageDeleted -> {
                        val matches = if (conversationType == ConversationType.DIRECT) {
                            event.conversationType == "direct" && event.targetId == targetId
                        } else {
                            event.conversationType == "channel" && event.targetId == targetId
                        }
                        if (matches) {
                            _messages.value = _messages.value.filter { it.id != event.messageId }
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
            // Edit mode
            webSocketClient.editMessage(editing.id, text.trim())
            _editingMessage.value = null
        } else {
            // New message
            webSocketClient.sendTextMessage(
                conversationType = conversationType,
                targetId = targetId,
                text = text.trim()
            )
        }
    }

    fun startEditing(message: Message) {
        _editingMessage.value = message
    }

    fun cancelEditing() {
        _editingMessage.value = null
    }

    fun deleteMessage(message: Message) {
        webSocketClient.deleteMessage(message.id)
    }

    fun onTyping(isTyping: Boolean) {
        webSocketClient.sendTyping(conversationType, targetId, isTyping)
    }

    fun sendWake() {
        if (_wakeCooldownSeconds.value > 0) return
        webSocketClient.sendWake(targetId)
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
        val window = sessionManager.messageEditWindowMinutes
        return MessageWindowValidator.canEditOrDelete(
            createdAtIso = message.createdAt,
            windowMinutesStr = window,
            isSuperAdmin = false,
            isDelete = false
        )
    }

    fun canDeleteMessage(message: Message): Boolean {
        val isAuthor = message.senderId == currentUserId
        val isAdmin = sessionManager.currentUser?.permissions?.isAdmin == true
        if (!isAuthor && !isAdmin) return false

        val window = sessionManager.messageDeleteWindowMinutes
        return MessageWindowValidator.canEditOrDelete(
            createdAtIso = message.createdAt,
            windowMinutesStr = window,
            isSuperAdmin = isAdmin,
            isDelete = true
        )
    }
}
