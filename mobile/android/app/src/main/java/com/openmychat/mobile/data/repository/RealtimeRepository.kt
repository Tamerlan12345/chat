package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Realtime chat, presence and call signalling over the authenticated WebSocket. Messages are not
 * sent from here: sending, editing, deleting and read marks go through the delivery engine
 * (`data/delivery`), which reads [deliveryFrames] and writes with [sendFrame].
 */
interface RealtimeRepository {
    /** Chat, presence and signalling events. Each message arrives once even if the server repeats it. */
    val events: Flow<WsEvent>

    /** Incoming voice frames, kept apart from [events] so they cannot crowd out chat traffic. */
    val audioFrames: Flow<WsEvent.AudioFrameReceived>

    val connectionState: StateFlow<ConnectionState>

    /** Every server frame as sent, in order, plus `socket_closed` when a socket goes away (DeliveryLink). */
    val deliveryFrames: Flow<JsonObject>

    /** A frame built by the delivery engine; false when no socket took it. */
    fun sendFrame(frame: JsonObject): Boolean

    /** Reconnect now: the delivery engine could not store what it received (delivery-state.md §5). */
    fun restartLink()

    /** «Смотрю этот чат» на переднем плане; null — ни один (multi-device.md §4). */
    fun sendViewing(conversation: Pair<ConversationType, Long>?): Boolean
    fun sendTyping(conversationType: ConversationType, targetId: Long, isTyping: Boolean): Boolean
    /** Автоматическое присутствие («online» / «away»), свой статус не меняется. */
    fun sendPresence(state: String): Boolean

    /** Свой статус вместе с текущим присутствием; null стирает его. */
    fun sendCustomStatus(state: String, customStatus: String?): Boolean
    fun setDnd(enabled: Boolean): Boolean
    fun sendWake(targetUserId: Long): Boolean

    fun sendCallOffer(targetUserId: Long): Boolean
    fun sendCallAnswer(targetUserId: Long): Boolean
    fun sendCallRejected(targetUserId: Long, reason: String? = null): Boolean
    fun sendCallEnd(targetUserId: Long, reason: String? = null): Boolean
    fun sendAudioFrame(targetUserId: Long, pcmSamples: ShortArray): Boolean
}

@Singleton
class DefaultRealtimeRepository @Inject constructor(
    private val webSocketClient: WebSocketClient
) : RealtimeRepository {
    override val events: Flow<WsEvent> get() = webSocketClient.events
    override val audioFrames: Flow<WsEvent.AudioFrameReceived> get() = webSocketClient.audioFrames
    override val connectionState: StateFlow<ConnectionState> get() = webSocketClient.connectionState
    override val deliveryFrames: Flow<JsonObject> get() = webSocketClient.deliveryFrames

    override fun sendFrame(frame: JsonObject) = webSocketClient.sendFrame(frame)
    override fun restartLink() = webSocketClient.restart()

    override fun sendViewing(conversation: Pair<ConversationType, Long>?) =
        webSocketClient.sendViewing(conversation?.first, conversation?.second)

    override fun sendTyping(conversationType: ConversationType, targetId: Long, isTyping: Boolean) =
        webSocketClient.sendTyping(conversationType, targetId, isTyping)

    override fun sendPresence(state: String) = webSocketClient.sendPresence(state)
    override fun sendCustomStatus(state: String, customStatus: String?) =
        webSocketClient.sendPresence(state, customStatus, includeCustomStatus = true)
    override fun setDnd(enabled: Boolean) = webSocketClient.setDnd(enabled)
    override fun sendWake(targetUserId: Long) = webSocketClient.sendWake(targetUserId)
    override fun sendCallOffer(targetUserId: Long) = webSocketClient.sendCallOffer(targetUserId)
    override fun sendCallAnswer(targetUserId: Long) = webSocketClient.sendCallAnswer(targetUserId)
    override fun sendCallRejected(targetUserId: Long, reason: String?) =
        webSocketClient.sendCallRejected(targetUserId, reason)

    override fun sendCallEnd(targetUserId: Long, reason: String?) = webSocketClient.sendCallEnd(targetUserId, reason)
    override fun sendAudioFrame(targetUserId: Long, pcmSamples: ShortArray) =
        webSocketClient.sendAudioFrame(targetUserId, pcmSamples)
}
