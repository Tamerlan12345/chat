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
import com.openmychat.mobile.data.realtime.resyncRequests
import kotlinx.coroutines.launch
import androidx.lifecycle.SavedStateHandle
import com.openmychat.mobile.data.model.ReportTargetType
import com.openmychat.mobile.data.repository.AccountRepository
import com.openmychat.mobile.data.repository.UnavailableAccountRepository
import com.openmychat.mobile.features.account.BlockController
import com.openmychat.mobile.features.account.ReportController
import com.openmychat.mobile.features.account.ReportTarget
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import com.openmychat.mobile.data.model.SendState
import com.openmychat.mobile.data.model.LocalUpload
import com.openmychat.mobile.data.repository.AttachmentRepository
import com.openmychat.mobile.data.repository.UnavailableAttachments
import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.features.attachments.AttachmentOpener
import com.openmychat.mobile.features.attachments.Attachments
import com.openmychat.mobile.features.attachments.UploadRules
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

private const val KEY_FOCUS_DONE = "chat.focus_done"

/** Сколько ждать эхо отправленного кадра до «не отправлено» (delivery-state.md `ACK_TIMEOUT_MS`). */
private const val ACK_TIMEOUT_MS = 10_000L


/** Отказ сервера в доставке личного сообщения (блокировка с любой стороны), contracts/registration.md §4. */
private const val DM_NOT_ALLOWED = "DM_NOT_ALLOWED"

/** Сколько текста сообщения показать в жалобе. */
private const val REPORT_EXCERPT = 160
private const val ATTACHMENT_SUBJECT = "Вложение"
private const val CANNOT_READ_FILE = "Не удалось прочитать файл"

/** Локальные записи ещё не подтверждённых сообщений: отрицательные id не пересекаются с серверными. */
private val nextLocalId = AtomicLong(0)


/** Why the composer of a direct chat is closed. */
enum class ComposerLock {
    NONE,

    /** I blocked this person: nothing goes either way until I unblock. */
    BLOCKED_BY_ME,

    /** The server refused a send with `DM_NOT_ALLOWED` (the other side blocked me, or I them elsewhere). */
    NOT_DELIVERABLE
}

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
    /** Переход к сообщению уже показан: после восстановления процесса его не повторяем. */
    private val saved: SavedStateHandle = SavedStateHandle(),
    /** Открыть на этом сообщении (переход из поиска). */
    @Assisted("focus") focusMessageId: Long? = null,
    /** Процесс вышел на передний план: историю догружаем (как после переподключения). */
    private val foreground: com.openmychat.mobile.data.realtime.ForegroundSignal = com.openmychat.mobile.data.realtime.ForegroundSignal(),
    /** Reports and blocks (contracts/registration.md §4). */
    account: AccountRepository = UnavailableAccountRepository,
    /** Upload, download and policy of files. */
    private val attachments: AttachmentRepository = UnavailableAttachments
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
    private val focusDone = saved.get<Boolean>(KEY_FOCUS_DONE) == true
    private var pendingFocus: Long? = if (focusDone) null else focusMessageId

    /** История собрана вокруг этого сообщения: обновление собирает её так же, без дыры. */
    private var windowAnchor: Long? = if (focusDone) focusMessageId else null

    private val conversation = ConversationRef(conversationType, targetId)

    /** True while the chat is on screen (resumed); only then are messages marked read. */
    private var isVisible = false

    private var typingResetJob: Job? = null
    private var wakeTimerJob: Job? = null

    val currentUserId: Long get() = sessionRepository.currentUserId ?: 0L

    private val messages: List<Message>
        get() = (_uiState.value as? ChatUiState.Content)?.messages.orEmpty()

    /** Ключи отправок, кадр которых хоть раз ушёл: сервер мог сохранить сообщение (delivery-state.md `maybe_stored`). */
    private val maybeStored = HashSet<String>()

    /** Ждём эхо отправленного кадра; по истечении времени сообщение «не отправлено». */
    private val ackJobs = HashMap<String, Job>()

    /** Файлы в пути на сервер, по ключу отправки. */
    private val uploads = UploadJobs()

    private val _notices = MutableSharedFlow<String>(extraBufferCapacity = 8)

    /** Короткие сообщения для снекбара: отказ в файле, сбой загрузки или скачивания. */
    val notices: SharedFlow<String> = _notices.asSharedFlow()

    /** Скачать и открыть вложение; картинки — во встроенном просмотре. */
    val opener = AttachmentOpener(attachments, viewModelScope, ::notice)

    /** Роль разрешает загрузку файлов (сервер: can_upload_files или администратор). */
    val canAttach: Boolean
        get() = sessionRepository.isAdmin || sessionRepository.currentUser.value?.permissions?.canUploadFiles != false

    /** Тап по плитке вложения. */
    fun openAttachment(message: Message) {
        Attachments.of(message)?.let(opener::open)
    }

    /** «Заблокировать» / «Разблокировать» the peer; null in channels and in a chat with oneself. */
    val blocks: BlockController? =
        if (conversationType == ConversationType.DIRECT && targetId != currentUserId) BlockController(account, viewModelScope, targetId) else null

    /** «Пожаловаться» on a message or on the peer. */
    val reports = ReportController(account, viewModelScope)

    private val notDeliverable = MutableStateFlow(false)

    /** The composer is closed while the peer is blocked or the server refuses delivery. */
    val composerLock: StateFlow<ComposerLock> = combine(blocks?.blocked ?: flowOf(false), notDeliverable) { blocked, refused ->
        lockOf(blocked, refused)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, lockOf(blocks?.blocked?.value == true, false))

    private fun lockOf(blocked: Boolean, refused: Boolean) = when {
        blocked -> ComposerLock.BLOCKED_BY_ME
        refused -> ComposerLock.NOT_DELIVERABLE
        else -> ComposerLock.NONE
    }

    init {
        // A block hides the person's messages on the server; an unblock shows them again and reopens sending.
        blocks?.let { controller ->
            viewModelScope.launch {
                controller.blocked.drop(1).collect { blocked ->
                    if (!blocked) notDeliverable.value = false
                    loadMessages()
                }
            }
        }
    }

    init {
        // A chat opened before shows its last history at once and refreshes underneath. Messages that
        // were still unconfirmed when it was left come back queued: no frame of a closed chat is in flight.
        historyCache.get(currentUserId, conversation)?.let { cached ->
            _uiState.value = ChatUiState.Content(
                cached.map { if (it.sendState == SendState.SENDING) it.copy(sendState = SendState.QUEUED) else it }
            )
        }
        viewModelScope.launch {
            _uiState.collect { state -> if (state is ChatUiState.Content) historyCache.put(currentUserId, conversation, state.messages) }
        }
        loadMessages()
        observeWebSocketEvents()
        viewModelScope.launch {
            connectionState.collect { onConnectionChanged(connected = it == ConnectionState.Connected) }
        }
        // After a drop or on foreground entry the history is reloaded once (unconfirmed local sends are kept
        // by loadMessages), only if the link is up.
        viewModelScope.launch {
            connectionState.resyncRequests(foreground.entered).collect { loadMessages() }
        }
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
                    saved[KEY_FOCUS_DONE] = true
                    if (window != null) windowAnchor = jump else _jumpUnavailable.value = true
                }
                val history = window ?: chatRepository.messages(conversationType, targetId)
                _uiState.update { state ->
                    // Keep realtime messages that arrived while the history request was in flight.
                    val live = (state as? ChatUiState.Content)?.messages.orEmpty()
                    val historyIds = history.mapTo(HashSet()) { it.id }
                    // Own messages the server has not confirmed stay; one it already stored comes in the history.
                    val storedKeys = history.mapNotNullTo(HashSet()) { it.clientMsgId }
                    val unconfirmed = live.filter { it.sendState != SendState.SENT && it.clientMsgId !in storedKeys }
                    storedKeys.forEach(::forgetSend)
                    ChatUiState.Content(
                        history + live.filter { it.sendState == SendState.SENT && it.id !in historyIds && it.id !in shownBefore } + unconfirmed
                    )
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

                        val key = msg.clientMsgId
                        val isEchoOfLocal = matches && key != null && msg.senderId == currentUserId &&
                            messages.any { it.clientMsgId == key && it.sendState != SendState.SENT }
                        if (isEchoOfLocal) {
                            // The server's record replaces the local one in its place (§3.4: the row keeps its identity).
                            forgetSend(key!!)
                            updateMessages { list ->
                                list.filter { it.id != msg.id }
                                    .map { if (it.clientMsgId == key && it.sendState != SendState.SENT) msg else it }
                            }
                        } else if (matches && messages.none { it.id == msg.id }) {
                            _uiState.update { state ->
                                when (state) {
                                    is ChatUiState.Content -> state.copy(messages = state.messages + msg)
                                    else -> ChatUiState.Content(listOf(msg))
                                }
                            }
                            if (isVisible && msg.senderId != currentUserId) markAsRead()
                        }
                    }
                    // Переподключились с открытым чатом: всё пришедшее за перерыв прочитано (multi-device.md §7.8).
                    is WsEvent.AuthSuccess -> if (isVisible) markAsRead()
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
                    is WsEvent.GenericError -> if (event.context == "send_message") onSendRejected(event)
                    else -> Unit
                }
            }
        }
    }

    fun sendMessage(text: String) {
        if (text.isBlank()) return
        val editing = _editingMessage.value
        if (editing == null && composerLock.value != ComposerLock.NONE) return
        if (editing != null) {
            realtimeRepository.editMessage(editing.id, text.trim())
            _editingMessage.value = null
        } else {
            // The bubble is on screen before anything goes to the network: a send never vanishes.
            val key = UUID.randomUUID().toString()
            val local = Message(
                id = -nextLocalId.incrementAndGet(),
                conversationType = conversationType,
                targetId = targetId,
                senderId = currentUserId,
                text = text.trim(),
                createdAt = Instant.now().toString(),
                senderName = sessionRepository.currentUser.value?.fullName.orEmpty(),
                clientMsgId = key,
                sendState = SendState.QUEUED
            )
            appendLocal(local)
            transmit(key)
        }
    }

    private fun appendLocal(local: Message) {
        _uiState.update { state ->
            when (state) {
                is ChatUiState.Content -> state.copy(messages = state.messages + local)
                else -> ChatUiState.Content(listOf(local))
            }
        }
    }

    /**
     * Отправка выбранного файла: проверка политики администратора, пузырь сразу, загрузка с прогрессом,
     * затем сообщение `file`/`image` с именем файла в тексте (как у настольного клиента). Очередь — та
     * же, что у текста: без связи ждёт, при отказе — «Повторить» / «Удалить».
     */
    fun sendAttachment(uri: String) {
        if (composerLock.value != ComposerLock.NONE) return
        viewModelScope.launch {
            val picked = attachments.describe(uri) ?: return@launch notice(CANNOT_READ_FILE)
            UploadRules.problem(picked.name, picked.size, attachments.policy())?.let { return@launch notice(it) }
            if (composerLock.value != ComposerLock.NONE) return@launch
            val key = UUID.randomUUID().toString()
            appendLocal(
                Message(
                    id = -nextLocalId.incrementAndGet(),
                    conversationType = conversationType,
                    targetId = targetId,
                    senderId = currentUserId,
                    text = picked.name,
                    type = if (Attachments.isImage(picked.name, picked.mimeType)) MessageType.IMAGE else MessageType.FILE,
                    createdAt = Instant.now().toString(),
                    senderName = sessionRepository.currentUser.value?.fullName.orEmpty(),
                    clientMsgId = key,
                    sendState = SendState.QUEUED,
                    upload = picked.toLocalUpload()
                )
            )
            transmit(key)
        }
    }

    /** «Отменить» у файла, который ещё не загружен: загрузка останавливается, пузырь уходит. */
    fun cancelUpload(message: Message) {
        val key = message.clientMsgId ?: return
        val current = messages.firstOrNull { it.clientMsgId == key && it.sendState != SendState.SENT } ?: return
        if (current.upload == null || current.upload.fileId != null) return
        uploads.cancel(key)
        updateMessages { list -> list.filter { it.clientMsgId != key } }
    }

    private fun notice(text: String) {
        _notices.tryEmit(text)
    }

    /** Файл уходит на сервер только при живой связи; результат — кадр сообщения или «не отправлено». */
    private fun startUpload(key: String) {
        if (uploads.isRunning(key)) return
        val upload = messages.firstOrNull { it.clientMsgId == key && it.sendState != SendState.SENT }?.upload ?: return
        if (connectionState.value != ConnectionState.Connected) {
            setSendState(key, SendState.QUEUED)
            return
        }
        updateUpload(key) { it.copy(progress = 0f, error = null) }
        setSendState(key, SendState.SENDING)
        uploads.start(key, viewModelScope) {
            try {
                val done = attachments.upload(upload.toPicked()) { progress -> onUploadProgress(key, progress) }
                val fileId = done.id.toLongOrNull() ?: throw ApiException(0, "SERIALIZATION_ERROR", UploadRules.REFUSED)
                updateUpload(key) { it.copy(fileId = fileId, size = done.fileSize, mimeType = done.mimeType, progress = null) }
                transmit(key)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Связь пропала посреди загрузки: файл ждёт её, как текст; иначе — причина сервера.
                val offline = e is ApiException && e.statusCode == 0 && connectionState.value != ConnectionState.Connected
                val reason = if (offline) null else UploadRules.failureText(e)
                updateUpload(key) { it.copy(progress = null, error = reason) }
                setSendState(key, if (offline) SendState.QUEUED else SendState.FAILED)
                reason?.let(::notice)
            }
        }
    }

    private fun onUploadProgress(key: String, progress: Float) {
        val current = messages.firstOrNull { it.clientMsgId == key }?.upload?.progress
        if (current != null && (current * 100).toInt() == (progress * 100).toInt()) return
        updateUpload(key) { if (it.fileId == null) it.copy(progress = progress) else it }
    }

    private fun updateUpload(key: String, transform: (LocalUpload) -> LocalUpload) {
        updateMessages { list ->
            list.map { msg ->
                val upload = msg.upload
                if (msg.clientMsgId == key && msg.sendState != SendState.SENT && upload != null) msg.copy(upload = transform(upload)) else msg
            }
        }
    }

    /** «Повторить»: тот же ключ, сервер не создаст копию, если уже сохранил. */
    fun retrySend(message: Message) {
        val key = message.clientMsgId ?: return
        if (message.sendState != SendState.FAILED) return
        setSendState(key, SendState.QUEUED)
        transmit(key)
    }

    /** «Удалить» у неотправленного: убрать из ленты и отозвать ключ, если сервер мог его сохранить. */
    fun discardFailed(message: Message) {
        val key = message.clientMsgId ?: return
        if (message.sendState != SendState.FAILED) return
        val mayBeStored = key in maybeStored
        uploads.cancel(key)
        forgetSend(key)
        if (mayBeStored) realtimeRepository.cancelMessage(key)
        updateMessages { list -> list.filter { it.clientMsgId != key } }
    }

    /** Кадр уходит, только пока сокет авторизован; иначе (или при отказе записи) сообщение ждёт переподключения. */
    private fun transmit(key: String) {
        val message = messages.firstOrNull { it.clientMsgId == key && it.sendState != SendState.SENT } ?: return
        val upload = message.upload
        val fileId = upload?.fileId
        // A file goes up first; its message follows once the server has it.
        if (upload != null && fileId == null) return startUpload(key)
        val written = connectionState.value == ConnectionState.Connected && if (upload != null && fileId != null) {
            realtimeRepository.sendAttachment(conversationType, targetId, message.text, message.type, attachmentMetadata(upload, fileId), key)
        } else {
            realtimeRepository.sendMessage(conversationType, targetId, message.text, key)
        }
        if (!written) {
            setSendState(key, SendState.QUEUED)
            return
        }
        maybeStored += key
        setSendState(key, SendState.SENDING)
        ackJobs.remove(key)?.cancel()
        ackJobs[key] = viewModelScope.launch {
            delay(ACK_TIMEOUT_MS)
            ackJobs.remove(key)
            setSendState(key, SendState.FAILED)
        }
    }

    private fun onConnectionChanged(connected: Boolean) {
        if (connected) {
            messages.filter { it.sendState == SendState.QUEUED }.forEach { it.clientMsgId?.let(::transmit) }
        } else {
            // The frame in flight is unanswered: wait for the connection and send it again with the same key.
            ackJobs.values.forEach { it.cancel() }
            ackJobs.clear()
            updateMessages { list ->
                // An upload runs over HTTP, apart from the socket: it settles on its own.
                list.map {
                    val uploading = it.clientMsgId?.let(uploads::isRunning) == true
                    if (it.sendState == SendState.SENDING && !uploading) it.copy(sendState = SendState.QUEUED) else it
                }
            }
        }
    }

    private fun onSendRejected(error: WsEvent.GenericError) {
        // Старый сервер не возвращает ключ: тогда опознаём отправку по возвращённому тексту.
        val key = error.clientMsgId ?: messages.firstOrNull {
            it.sendState == SendState.SENDING && it.text == error.originalText
        }?.clientMsgId
        if (key == null || messages.none { it.clientMsgId == key && it.sendState != SendState.SENT }) return
        // A refusal means the server stored nothing: there is no key to revoke.
        forgetSend(key)
        setSendState(key, SendState.FAILED)
        if (error.code == DM_NOT_ALLOWED && conversationType == ConversationType.DIRECT) notDeliverable.value = true
    }

    /** Someone else's message the server has (not a local, failed or deleted one). */
    fun canReportMessage(message: Message): Boolean =
        message.sendState == SendState.SENT && message.id > 0 && message.senderId != currentUserId && !message.isDeleted

    fun reportMessage(message: Message) {
        if (!canReportMessage(message)) return
        val body = message.text.trim().take(REPORT_EXCERPT).ifEmpty { ATTACHMENT_SUBJECT }
        val subject = if (message.senderName.isBlank()) body else "${message.senderName}: $body"
        reports.open(ReportTarget(ReportTargetType.MESSAGE, message.id, subject))
    }

    fun reportPeer(name: String) {
        if (blocks == null) return
        reports.open(ReportTarget(ReportTargetType.USER, targetId, name))
    }

    fun block(name: String) {
        blocks?.block(name)
    }

    fun unblock() {
        blocks?.unblock()
    }

    private fun setSendState(key: String, state: SendState) {
        updateMessages { list -> list.map { if (it.clientMsgId == key && it.sendState != SendState.SENT) it.copy(sendState = state) else it } }
    }

    /** Отправка закончена (подтверждена, отказана, удалена): ни таймера, ни отзыва ключа не нужно. */
    private fun forgetSend(key: String) {
        ackJobs.remove(key)?.cancel()
        maybeStored.remove(key)
    }

    fun startEditing(message: Message) {
        _editingMessage.value = message
    }

    fun cancelEditing() {
        _editingMessage.value = null
    }

    fun deleteMessage(message: Message) {
        if (message.sendState != SendState.SENT) return
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
        if (message.sendState != SendState.SENT) return false
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
        if (message.sendState != SendState.SENT) return false
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
