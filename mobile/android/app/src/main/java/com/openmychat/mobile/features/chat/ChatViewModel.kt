package com.openmychat.mobile.features.chat

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.core.util.MessageWindowValidator
import com.openmychat.mobile.data.delivery.DeliveryEngine
import com.openmychat.mobile.data.delivery.DeliveryState
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import com.openmychat.mobile.data.model.ReportTargetType
import com.openmychat.mobile.data.model.SendState
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.data.realtime.ConversationRef
import com.openmychat.mobile.data.realtime.ForegroundSignal
import com.openmychat.mobile.data.realtime.resyncRequests
import com.openmychat.mobile.data.repository.AccountRepository
import com.openmychat.mobile.data.repository.AttachmentRepository
import com.openmychat.mobile.data.repository.ChatRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.data.repository.UnavailableAccountRepository
import com.openmychat.mobile.data.repository.UnavailableAttachments
import com.openmychat.mobile.features.account.BlockController
import com.openmychat.mobile.features.account.ReportController
import com.openmychat.mobile.features.account.ReportTarget
import com.openmychat.mobile.features.attachments.AttachmentOpener
import com.openmychat.mobile.features.attachments.Attachments
import com.openmychat.mobile.features.attachments.UploadRules
import dagger.assisted.Assisted
import dagger.assisted.AssistedFactory
import dagger.assisted.AssistedInject
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val KEY_FOCUS_DONE = "chat.focus_done"

/** Сколько текста сообщения показать в жалобе. */
private const val REPORT_EXCERPT = 160
private const val ATTACHMENT_SUBJECT = "Вложение"
private const val CANNOT_READ_FILE = "Не удалось прочитать файл"
private const val CANNOT_KEEP_FILE = "Не удалось сохранить файл для отправки"
private const val NOT_SAVED = "Сообщение не сохранено — попробуйте ещё раз"

/** Message history state of a conversation; composer chrome (typing, editing, wake) is separate. */
sealed interface ChatUiState {
    data object Loading : ChatUiState
    data class Error(val message: String) : ChatUiState
    data class Content(val messages: List<Message>) : ChatUiState
}

/**
 * One conversation on screen. Messages, the send queue, edits and deletes live in the process-wide
 * delivery engine (delivery-state.md): this view model projects its model for this conversation
 * ([ChatProjection]), hands user actions to it and loads history pages into it. Files go through
 * [AttachmentSends] first.
 */
@HiltViewModel(assistedFactory = ChatViewModel.Factory::class)
class ChatViewModel @AssistedInject constructor(
    @Assisted val conversationType: ConversationType,
    @Assisted("target") val targetId: Long,
    private val chatRepository: ChatRepository,
    private val realtimeRepository: RealtimeRepository,
    private val sessionRepository: SessionRepository,
    private val activeConversations: ActiveConversationRegistry,
    /** The process-wide delivery model: outbox, ops, sync and the conversation cache. */
    private val delivery: DeliveryEngine,
    /** Files on their way into the outbox. */
    private val sends: AttachmentSends,
    /** Переход к сообщению уже показан: после восстановления процесса его не повторяем. */
    private val saved: SavedStateHandle = SavedStateHandle(),
    /** Открыть на этом сообщении (переход из поиска). */
    @Assisted("focus") focusMessageId: Long? = null,
    /** Процесс вышел на передний план: историю догружаем (как после переподключения). */
    private val foreground: ForegroundSignal = ForegroundSignal(),
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

    /** `direct:<peer>` / `channel:<id>` — the key of this conversation in the delivery model. */
    private val conversationKey = DeliveryEngine.conversationKey(conversationType == ConversationType.CHANNEL, targetId)
    private val projection = ChatProjection(conversationType, targetId)

    private sealed interface Load {
        data object Pending : Load
        data object Done : Load
        data class Failed(val message: String) : Load
    }

    private var load: Load = Load.Pending

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

    /** Older pages (`beforeId`): one at a time, and none once the start of the conversation is reached. */
    private var loadingOlder = false
    private var reachedStart = false

    val currentUserId: Long get() = sessionRepository.currentUserId ?: 0L

    /** The account this screen was opened for: what it writes belongs to that account only. */
    private val screenAccount: Long? = sessionRepository.currentUserId

    private val messages: List<Message>
        get() = (_uiState.value as? ChatUiState.Content)?.messages.orEmpty()

    private val _notices = MutableSharedFlow<String>(extraBufferCapacity = 8)

    /** Короткие сообщения для снекбара: отказ в файле, сбой загрузки или скачивания, отказ сервера. */
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

    /** The server's `DM_NOT_ALLOWED` for this direct chat, and what reopens it. */
    private val refusedDelivery = RefusedDelivery(conversationKey, targetId)

    /** The composer is closed while the peer is blocked or the server refuses delivery. */
    val composerLock: StateFlow<ComposerLock> = combine(blocks?.blocked ?: flowOf(false), refusedDelivery.closed) { blocked, refused ->
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
                    if (!blocked) refusedDelivery.reopen(model())
                    loadMessages(replaceAll = true)
                }
            }
        }
    }

    init {
        // What the delivery model already holds for this chat (opened before, or the cache of the last
        // run) shows at once; the server's page refreshes it underneath.
        rebuild()
        viewModelScope.launch { delivery.state.collect { rebuild() } }
        viewModelScope.launch { sends.uploads.collect { rebuild() } }
        viewModelScope.launch { sends.handedOver.collect { rebuild() } }
        viewModelScope.launch {
            sends.notices.collect { (conv, reason) -> if (conv == conversationKey) notice(reason) }
        }
        viewModelScope.launch {
            delivery.userErrors.collect { code -> if (isVisible) DeliveryNotices.text(code)?.let(::notice) }
        }
        loadMessages()
        observeWebSocketEvents()
        // After a drop or on foreground entry the history is reloaded once, only if the link is up.
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
            delivery.conversationOpened(conversationKey)
        } else {
            activeConversations.leave(conversation)
            if (delivery.state.value.visible == conversationKey) delivery.conversationClosed()
        }
    }

    override fun onCleared() {
        typing.stop()
        activeConversations.leave(conversation)
        if (isVisible && delivery.state.value.visible == conversationKey) delivery.conversationClosed()
        super.onCleared()
    }

    /** Экран прокрутил к сообщению и подсветил его. */
    fun onFocusShown() {
        _focus.value = null
    }

    /** The model's state for this user (another account's leftovers are never shown). */
    private fun model(): DeliveryState? {
        val state = delivery.state.value
        return if (state.me != null && state.me != currentUserId) null else state
    }

    private fun rebuild() {
        val state = model()
        val list = if (state == null) emptyList() else projection.build(
            state = state,
            conversation = conversationKey,
            me = currentUserId,
            myName = sessionRepository.currentUser.value?.fullName.orEmpty(),
            uploads = sends.uploads.value,
            handedOver = sends.handedOver.value
        )
        if (state != null && conversationType == ConversationType.DIRECT) refusedDelivery.observe(state, list)
        val known = state?.messages?.containsKey(conversationKey) == true
        _uiState.value = when {
            known || list.isNotEmpty() || load == Load.Done -> ChatUiState.Content(list)
            load is Load.Failed -> ChatUiState.Error((load as Load.Failed).message)
            else -> ChatUiState.Loading
        }
    }

    /** Ids of server messages of this chat in the model now. */
    private fun serverIds(): Set<Long> =
        delivery.state.value.messages[conversationKey].orEmpty().mapTo(HashSet()) { it.id }

    fun loadMessages() = loadMessages(replaceAll = false)

    /**
     * The latest page (or the window around a found message) replaces what is cached for this chat:
     * messages the server no longer returns there are dropped. [replaceAll] — also the older ones
     * (after a block or unblock the server hides or shows a person's messages everywhere).
     */
    private fun loadMessages(replaceAll: Boolean) {
        viewModelScope.launch {
            val shownBefore = serverIds()
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
                val oldest = history.minOfOrNull { it.id }
                val stale = if (replaceAll || window != null || oldest == null) shownBefore else shownBefore.filterTo(HashSet()) { it >= oldest }
                delivery.replaceHistory(conversationKey, history.map(ChatProjection::record), stale)
                load = Load.Done
                if (conversationType == ConversationType.DIRECT) refusedDelivery.reopen(model())
                rebuild()
                if (jump != null && window != null) _focus.value = jump
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // A cached history stays on screen; the screen says it could not be refreshed.
                if (_uiState.value is ChatUiState.Content) {
                    _refreshFailed.value = true
                } else {
                    load = Load.Failed(e.message ?: "Не удалось загрузить сообщения")
                    rebuild()
                }
            }
        }
    }

    /** The page before the oldest loaded message (`beforeId`), when the reader scrolls up to it. */
    fun loadOlder() {
        if (loadingOlder || reachedStart) return
        val oldest = delivery.state.value.messages[conversationKey]?.firstOrNull()?.id ?: return
        loadingOlder = true
        viewModelScope.launch {
            try {
                val page = chatRepository.messagesBefore(conversationType, targetId, oldest)
                if (page.size < ChatRepository.PAGE_SIZE) reachedStart = true
                if (page.isNotEmpty()) delivery.historyPage(page.map(ChatProjection::record))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The next scroll to the top asks again.
            } finally {
                loadingOlder = false
            }
        }
    }

    private fun observeWebSocketEvents() {
        viewModelScope.launch {
            realtimeRepository.events.collect { event ->
                when (event) {
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
                                    delay(TypingSignal.PEER_HOLD_MS)
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

    /** Sends the composer text (or saves the edit); see [send]. */
    fun sendMessage(text: String) = send(text, replyTo = null) {}

    /**
     * «Отправить»: the message goes into the durable outbox, and only once it is on disk is
     * [onAccepted] called — the composer clears then (delivery-state.md §7.4). [replyTo] is sent as
     * `reply_to_id`. While a message is being edited, this saves the edit instead.
     */
    fun send(text: String, replyTo: Message?, onAccepted: () -> Unit) {
        if (text.isBlank()) return
        val editing = _editingMessage.value
        if (editing == null && composerLock.value != ComposerLock.NONE) return
        // One press, one message: a second tap before the first is stored (the composer still shows
        // the text until then) is not a second send.
        if (submitting) return
        submitting = true
        viewModelScope.launch {
            val outcome = try {
                if (editing != null) {
                    delivery.editSent(editing.id, text.trim())
                } else {
                    // Written by this screen's account: never taken into another account's queue.
                    delivery.enqueue(
                        conversationKey, text.trim(),
                        replyToId = replyTo?.id?.takeIf { it > 0 && replyTo.sendState == SendState.SENT },
                        owner = screenAccount, ownerStated = true
                    )
                }
            } finally {
                submitting = false
            }
            when {
                !outcome.persisted -> notice(NOT_SAVED)
                outcome.userError != null -> DeliveryNotices.text(outcome.userError!!)?.let(::notice)
                else -> {
                    if (editing != null) _editingMessage.value = null
                    onAccepted()
                }
            }
        }
    }

    private var submitting = false

    /**
     * Отправка выбранного файла: проверка политики администратора, затем файл встаёт в очередь
     * (личная копия на устройстве — переживает перезапуск) и уходит, когда есть связь; дальше —
     * сообщение `file`/`image` с именем файла в тексте (как у настольного клиента).
     */
    fun sendAttachment(uri: String, replyTo: Message? = null) {
        if (composerLock.value != ComposerLock.NONE) return
        viewModelScope.launch {
            val picked = attachments.describe(uri) ?: return@launch notice(CANNOT_READ_FILE)
            UploadRules.problem(picked.name, picked.size, attachments.policy())?.let { return@launch notice(it) }
            if (composerLock.value != ComposerLock.NONE) return@launch
            val reply = replyTo?.id?.takeIf { it > 0 && replyTo.sendState == SendState.SENT }
            if (!sends.add(conversationKey, picked, reply)) notice(CANNOT_KEEP_FILE)
        }
    }

    /** «Отменить» у файла, который ещё не загружен: загрузка останавливается, пузырь уходит. */
    fun cancelUpload(message: Message) {
        val key = message.clientMsgId ?: return
        val upload = message.upload ?: return
        if (upload.fileId != null) return
        sends.cancel(key)
    }

    private fun notice(text: String) {
        _notices.tryEmit(text)
    }

    /** «Повторить»: тот же ключ (новый — только после ошибки ключа), сервер не создаст копию. */
    fun retrySend(message: Message) {
        val key = message.clientMsgId ?: return
        if (message.sendState != SendState.FAILED) return
        if (isPendingUpload(key)) {
            sends.retry(key)
            return
        }
        viewModelScope.launch {
            val outcome = delivery.retry(key)
            if (!outcome.persisted) notice(NOT_SAVED)
        }
    }

    /** «Удалить» у неотправленного (в очереди, в пути, не отправлено): отменённое не уйдёт никогда. */
    fun discardFailed(message: Message) = cancelUnsent(message)

    /**
     * Отмена неподтверждённого сообщения (delivery-state.md §7.10): файл, который ещё не загружен,
     * просто забывается; запись очереди удаляется, а если сервер мог её сохранить — отзывается.
     */
    fun cancelUnsent(message: Message) {
        val key = message.clientMsgId ?: return
        if (message.sendState == SendState.SENT) return
        if (isPendingUpload(key)) {
            sends.cancel(key)
            return
        }
        viewModelScope.launch {
            val outcome = delivery.cancel(key)
            if (!outcome.persisted) notice(NOT_SAVED)
        }
    }

    private fun isPendingUpload(key: String) = sends.uploads.value.any { it.pending.clientMsgId == key } &&
        delivery.state.value.outbox.none { it.clientMsgId == key }

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

    fun startEditing(message: Message) {
        _editingMessage.value = message
    }

    fun cancelEditing() {
        _editingMessage.value = null
    }

    /**
     * «Удалить» (after the confirmation dialog). An own message goes through the delivery model: it is
     * hidden at once and the delete is retried until the tombstone confirms it (§7.3). An
     * administrator deleting someone else's message sends the frame directly — the model only
     * deletes own messages.
     */
    fun deleteMessage(message: Message) {
        if (message.sendState != SendState.SENT) return cancelUnsent(message)
        if (message.senderId == currentUserId) {
            viewModelScope.launch {
                val outcome = delivery.delete(message.id)
                if (!outcome.persisted) notice(NOT_SAVED) else outcome.userError?.let(DeliveryNotices::text)?.let(::notice)
            }
        } else if (sessionRepository.isAdmin) {
            realtimeRepository.sendFrame(buildJsonObject {
                put("type", "delete_message")
                put("messageId", message.id)
            })
        }
    }

    /** The composer field changed ([isTyping] = it has text) or was sent (false). */
    fun onTyping(isTyping: Boolean) = typing.onInput(isTyping)

    private val typing = TypingSignal(viewModelScope) { active -> realtimeRepository.sendTyping(conversationType, targetId, active) }

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

/** `user_error` codes of the delivery model (delivery-state.md §5) in Russian. */
object DeliveryNotices {
    fun text(code: String): String? = when (code) {
        "DELETE_NOT_CONFIRMED" -> "Удаление не подтвердилось — сообщение снова показано"
        "DELETE_REJECTED" -> "Сообщение нельзя удалить"
        "EDIT_REJECTED" -> "Изменение не сохранено"
        "NOT_EDITABLE" -> "Это сообщение нельзя изменить"
        "NOT_DELETABLE" -> "Это сообщение нельзя удалить"
        "EMPTY_TEXT" -> "Пустое сообщение не отправляется"
        "TEXT_TOO_LONG" -> "Сообщение слишком длинное"
        "INVALID_CLIENT_MSG_ID", "INVALID_CONVERSATION", "INVALID_MESSAGE_TYPE" -> "Сообщение не удалось поставить в очередь"
        else -> null
    }
}
