package com.openmychat.mobile.testing

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.repository.RealtimeRepository
import kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The WebSocket as tests drive it: [emit] delivers a typed event (and its frame to the delivery
 * engine), setting [connectionState] behaves like a socket authenticating (`auth_success`) or
 * closing (`socket_closed`), and frames the engine writes are recorded in [sent] as short commands,
 * e.g. "send_message direct 7 hi", "send_message file direct 7 a.pdf", "mark_read direct 7".
 */
class FakeRealtimeRepository(
    /** The account the next socket authenticates as. */
    var me: Long = FakeSessionRepository.ME
) : RealtimeRepository {
    private val _events = MutableSharedFlow<WsEvent>(extraBufferCapacity = 64)
    private val _audioFrames = MutableSharedFlow<WsEvent.AudioFrameReceived>(extraBufferCapacity = 64)
    private val _frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 256)
    override val events: Flow<WsEvent> = _events
    override val audioFrames: Flow<WsEvent.AudioFrameReceived> = _audioFrames
    override val deliveryFrames: Flow<JsonObject> = _frames

    override val connectionState: MutableStateFlow<ConnectionState> = LinkState(ConnectionState.Connected) { old, new ->
        val wasUp = old == ConnectionState.Connected
        val isUp = new == ConnectionState.Connected
        if (wasUp && !isUp) check(_frames.tryEmit(buildJsonObject { put("type", "socket_closed") }))
        if (!wasUp && isUp) check(_frames.tryEmit(authSuccess(me)))
    }

    /** Outgoing commands in order, e.g. "mark_read direct 7" or "call_end 7". */
    val sent = mutableListOf<String>()

    /** Every frame the delivery engine wrote, as written. */
    val frames = mutableListOf<JsonObject>()

    /** false — сокет закрыт: команды не уходят (send возвращает false). */
    var accepting = true
    var restarts = 0

    fun emit(event: WsEvent) {
        check(_events.tryEmit(event))
        frameOf(event)?.let { check(_frames.tryEmit(it)) }
    }

    /** A server frame for the delivery engine only (contract shape). */
    fun emitFrame(frame: JsonObject) = check(_frames.tryEmit(frame))

    fun emitAudio(frame: WsEvent.AudioFrameReceived) = check(_audioFrames.tryEmit(frame))

    private fun record(command: String): Boolean {
        if (!accepting) return false
        sent += command
        return true
    }

    /** Ключи отправок в порядке ухода кадров `send_message`. */
    val sentClientMsgIds = mutableListOf<String>()

    /** Metadata of the last `send_message` with a file. */
    var lastAttachmentMetadata: JsonObject? = null

    override fun sendFrame(frame: JsonObject): Boolean {
        val type = frame.str("type")
        val command = when (type) {
            "send_message" -> {
                val msgType = frame.str("msgType") ?: "text"
                val prefix = if (msgType == "text") "send_message" else "send_message $msgType"
                "$prefix ${frame.str("conversationType")} ${frame.str("targetId")} ${frame.str("text")}"
            }
            "cancel_message" -> "cancel_message ${frame.str("client_msg_id")}"
            "edit_message" -> "edit_message ${frame.str("messageId")}"
            "delete_message" -> "delete_message ${frame.str("messageId")}"
            "mark_read" -> "mark_read ${frame.str("conversationType")} ${frame.str("targetId")}"
            else -> type.orEmpty()
        }
        if (!record(command)) return false
        frames += frame
        if (type == "send_message") {
            sentClientMsgIds += frame.str("client_msg_id").orEmpty()
            if (frame.str("msgType") != "text") lastAttachmentMetadata = frame["metadata"] as? JsonObject
        }
        return true
    }

    override fun restartLink() {
        restarts++
    }

    override fun sendViewing(conversation: Pair<ConversationType, Long>?) =
        record(if (conversation == null) "viewing null" else "viewing ${conversation.first.value} ${conversation.second}")
    override fun sendTyping(conversationType: ConversationType, targetId: Long, isTyping: Boolean) =
        record("typing $targetId $isTyping")
    override fun sendPresence(state: String) = record("presence $state")
    override fun sendCustomStatus(state: String, customStatus: String?) = record("presence $state custom=$customStatus")
    override fun setDnd(enabled: Boolean) = record("set_dnd $enabled")
    override fun sendWake(targetUserId: Long) = record("wake_send $targetUserId")
    override fun sendCallOffer(targetUserId: Long) = record("call_offer $targetUserId")
    override fun sendCallAnswer(targetUserId: Long) = record("call_answer $targetUserId")
    override fun sendCallRejected(targetUserId: Long, reason: String?) = record("call_rejected $targetUserId")
    override fun sendCallEnd(targetUserId: Long, reason: String?) = record("call_end $targetUserId")
    override fun sendAudioFrame(targetUserId: Long, pcmSamples: ShortArray) = record("audio $targetUserId")

    companion object {
        private val json = Json { encodeDefaults = true }

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

        fun authSuccess(userId: Long) = buildJsonObject {
            put("type", "auth_success")
            put("user", buildJsonObject { put("id", userId) })
        }

        /** The frame the server sends for a typed chat event (what the delivery engine reads). */
        fun frameOf(event: WsEvent): JsonObject? = when (event) {
            is WsEvent.NewMessage -> buildJsonObject {
                put("type", "new_message")
                put("message", json.encodeToJsonElement(Message.serializer(), event.message))
            }
            is WsEvent.GenericError -> buildJsonObject {
                put("type", "error")
                event.context?.let { put("context", it) }
                put("message", event.message)
                event.originalText?.let { put("text", it) }
                event.clientMsgId?.let { put("client_msg_id", it) }
                event.code?.let { put("code", it) }
            }
            is WsEvent.MessageDeleted -> buildJsonObject {
                put("type", "message_deleted")
                put("messageId", event.messageId)
                put("conversationType", event.conversationType)
                put("targetId", event.targetId)
            }
            is WsEvent.MessageStatusUpdated -> buildJsonObject {
                put("type", "message_status_updated")
                put("messageId", event.messageId)
                put("status", event.status)
                put("userId", event.userId)
                put("timestamp", event.timestamp)
            }
            is WsEvent.MessagesRead -> buildJsonObject {
                put("type", "messages_read")
                put("byUserId", event.byUserId)
                put("messageIds", JsonArray(event.messageIds.map(::JsonPrimitive)))
            }
            else -> null
        }
    }
}

/** A [MutableStateFlow] that reports each change of its value to [onChange] (old, new). */
@OptIn(ExperimentalForInheritanceCoroutinesApi::class)
class LinkState<T> private constructor(
    private val backing: MutableStateFlow<T>,
    private val onChange: (T, T) -> Unit
) : MutableStateFlow<T> by backing {
    constructor(initial: T, onChange: (T, T) -> Unit) : this(MutableStateFlow(initial), onChange)

    override var value: T
        get() = backing.value
        set(next) {
            val old = backing.value
            backing.value = next
            if (old != next) onChange(old, next)
        }
}
