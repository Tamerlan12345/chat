package com.openmychat.mobile.data.notifications

import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.data.realtime.ConversationRef
import com.openmychat.mobile.data.realtime.Presence
import com.openmychat.mobile.data.realtime.PresenceController
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.di.ApplicationScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/** Куда уходят уведомления о сообщениях (система Android; в тестах — запись). */
interface NotificationSink {
    /**
     * Показать или обновить уведомление переписки [conversation] (одно на переписку). [chatTitle] —
     * заголовок экрана переписки, который откроется по нажатию.
     */
    fun show(conversation: ConversationRef, title: String, text: String, chatTitle: String)

    /** Снять показанное уведомление переписки. */
    fun cancel(conversation: ConversationRef)

    /** Снять все уведомления приложения (учётная запись вышла или сменилась). */
    fun cancelAll()

    /** Входящий звонок из push (приложение не на связи): нажатие открывает приложение. */
    fun showIncomingCall(callerId: Long, callerName: String?) = Unit
}

/** Переписку прочитали на другом устройстве (кадр conversation_read или тихий push read). */
@Singleton
class ConversationReadBus @Inject constructor() {
    private val _reads = MutableSharedFlow<ConversationRef>(extraBufferCapacity = 64)
    val reads: SharedFlow<ConversationRef> = _reads.asSharedFlow()

    fun emit(conversation: ConversationRef) {
        _reads.tryEmit(conversation)
    }
}

/** Разобранный data-push FCM (push.md §2): только тип и id, все значения — строки. */
sealed interface PushPayload {
    data class NewMessage(val conversation: ConversationRef, val messageId: Long) : PushPayload
    data class Read(val conversation: ConversationRef) : PushPayload
    data class Call(val callerId: Long) : PushPayload

    companion object {
        fun parse(data: Map<String, String>): PushPayload? {
            fun conversation(): ConversationRef? {
                val type = when (data["conversationType"]) {
                    "direct" -> ConversationType.DIRECT
                    "channel" -> ConversationType.CHANNEL
                    else -> return null
                }
                val targetId = data["targetId"]?.toLongOrNull()?.takeIf { it > 0 } ?: return null
                return ConversationRef(type, targetId)
            }
            return when (data["type"]) {
                "message" -> {
                    val messageId = data["messageId"]?.toLongOrNull()?.takeIf { it > 0 } ?: return null
                    conversation()?.let { NewMessage(it, messageId) }
                }
                "read" -> conversation()?.let { Read(it) }
                "call" -> data["callerId"]?.toLongOrNull()?.takeIf { it > 0 }?.let { Call(it) }
                else -> null
            }
        }
    }
}

/**
 * Уведомления о сообщениях по правилу «смотрит ли сотрудник этот чат» (multi-device.md §5, §6, §8).
 *
 * - Кадр нового сообщения: уведомление — только при `notify == true`; без поля (старый сервер) —
 *   прежнее локальное правило: не своё, не «Не беспокоить», переписка не открыта здесь на экране.
 * - `conversation_read` (прочитали на другом устройстве): снять уведомление переписки и обнулить её
 *   непрочитанное ([ConversationReadBus]).
 * - Push ([onPush]): `read` — то же снятие, ничего не показывать; `message` — не показывать, если
 *   сообщение уже пришло по сокету или переписка открыта; звонки — без изменений, не здесь.
 *
 * - Учётная запись вышла или сменилась: все её уведомления снимаются (final review M3, parity P10) —
 *   текст чужой переписки не остаётся в шторке, а нажатие не открывает её в другом сеансе.
 *
 * Решение «кому» принимает сервер; клиент его не повторяет.
 */
@Singleton
class MessageNotifier @Inject constructor(
    private val realtime: RealtimeRepository,
    private val sink: NotificationSink,
    private val readBus: ConversationReadBus,
    private val activeConversations: ActiveConversationRegistry,
    private val presence: PresenceController,
    private val session: com.openmychat.mobile.data.repository.SessionRepository,
    @ApplicationScope scope: CoroutineScope
) {
    @Volatile private var myId: Long? = null
    @Volatile private var dnd = false

    /** Сообщения, уже полученные по сокету: push о них не показывается. */
    private val known = object : LinkedHashMap<Long, Unit>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, Unit>?): Boolean = size > 1024
    }

    init {
        scope.launch { realtime.events.collect(::onEvent) }
        // Переписку открыли здесь — её уведомление больше не нужно.
        scope.launch { activeConversations.active.collect { open -> if (open != null) sink.cancel(open) } }
        scope.launch {
            var seen = false
            var last: Long? = null
            session.currentUser.map { it?.id }.distinctUntilChanged().collect { account ->
                if (seen && account != last) {
                    sink.cancelAll()
                    synchronized(known) { known.clear() }
                    myId = null
                }
                seen = true
                last = account
            }
        }
    }

    private fun onEvent(event: WsEvent) {
        when (event) {
            is WsEvent.AuthSuccess -> {
                myId = event.user.id
                dnd = event.user.status == UserStatus.DND
            }
            is WsEvent.UserStatusChanged -> if (event.userId == myId) dnd = event.status == UserStatus.DND
            is WsEvent.NewMessage -> onMessage(event.message, event.notify)
            is WsEvent.ConversationRead -> readElsewhere(ConversationRef(event.conversationType, event.targetId))
            else -> Unit
        }
    }

    private fun onMessage(message: Message, notify: Boolean?) {
        synchronized(known) { known[message.id] = Unit }
        val me = myId
        val conversation = conversationOf(message, me)
        val show = notify ?: (message.senderId != me && !dnd && !isOpenHere(conversation))
        if (!show) return
        showMessage(conversation, message)
    }

    private fun showMessage(conversation: ConversationRef, message: Message) {
        val title = when (message.conversationType) {
            ConversationType.CHANNEL -> listOfNotNull(message.channelName?.let { "#$it" }, message.senderName.ifBlank { null })
                .joinToString(" · ").ifBlank { DEFAULT_TEXT }
            ConversationType.DIRECT -> message.senderName.ifBlank { DEFAULT_TEXT }
        }
        val chatTitle = when (message.conversationType) {
            ConversationType.CHANNEL -> message.channelName ?: DEFAULT_TITLE
            ConversationType.DIRECT -> message.senderName.ifBlank { DEFAULT_TITLE }
        }
        sink.show(conversation, title, preview(message), chatTitle)
    }

    /**
     * Push о сообщении: показывать ли его вообще — не пришло ли оно уже по сокету, не «Не беспокоить»,
     * не открыта ли переписка здесь (push.md §5).
     */
    fun wantsPush(payload: PushPayload.NewMessage): Boolean {
        val already = synchronized(known) { payload.messageId in known }
        return !already && !dnd && !isOpenHere(payload.conversation)
    }

    /**
     * Push о сообщении, когда приложение забрало его с нашего сервера ([message]) — с именем и текстом;
     * null — забрать не удалось: только «Новое сообщение». Переписка — из push (с точки зрения получателя).
     */
    fun showPushed(payload: PushPayload.NewMessage, message: Message?) {
        if (!wantsPush(payload)) return
        synchronized(known) { known[payload.messageId] = Unit }
        if (message == null) {
            sink.show(payload.conversation, DEFAULT_TITLE, DEFAULT_TEXT, DEFAULT_TITLE)
        } else {
            showMessage(payload.conversation, message)
        }
    }

    /** Push о звонке: [callerName] — с нашего сервера, если удалось. */
    fun showIncomingCall(callerId: Long, callerName: String?) {
        sink.showIncomingCall(callerId, callerName)
    }

    /** Data-push FCM (обработчик сервиса передаёт сюда `remoteMessage.data`). */
    fun onPush(data: Map<String, String>) {
        when (val payload = PushPayload.parse(data)) {
            is PushPayload.Read -> readElsewhere(payload.conversation)
            is PushPayload.NewMessage -> {
                val already = synchronized(known) { payload.messageId in known }
                if (already || dnd || isOpenHere(payload.conversation)) return
                sink.show(payload.conversation, DEFAULT_TITLE, DEFAULT_TEXT, DEFAULT_TITLE)
            }
            is PushPayload.Call, null -> Unit // звонки — без изменений (push.md §3)
        }
    }

    private fun readElsewhere(conversation: ConversationRef) {
        sink.cancel(conversation)
        readBus.emit(conversation)
    }

    private fun isOpenHere(conversation: ConversationRef): Boolean =
        presence.presence.value == Presence.ONLINE && activeConversations.active.value == conversation

    companion object {
        const val DEFAULT_TITLE = "CentyChat"
        const val DEFAULT_TEXT = "Новое сообщение"

        /** Переписка с точки зрения получателя: в личной — собеседник, в канале — канал. */
        fun conversationOf(message: Message, me: Long?): ConversationRef = when (message.conversationType) {
            ConversationType.CHANNEL -> ConversationRef(ConversationType.CHANNEL, message.targetId)
            ConversationType.DIRECT -> ConversationRef(
                ConversationType.DIRECT,
                if (message.senderId == me) message.targetId else message.senderId
            )
        }

        fun preview(message: Message): String = when {
            message.text.isNotBlank() -> message.text
            message.type == MessageType.IMAGE -> "Фото"
            message.type == MessageType.FILE -> "Файл"
            else -> DEFAULT_TEXT
        }
    }
}
