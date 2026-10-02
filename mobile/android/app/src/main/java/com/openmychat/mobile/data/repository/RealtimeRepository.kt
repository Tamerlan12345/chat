package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject
import javax.inject.Singleton

/** Realtime chat, presence and call signalling over the authenticated WebSocket. */
interface RealtimeRepository {
    /** Chat, presence and signalling events. Each message arrives once even if the server repeats it. */
    val events: Flow<WsEvent>

    /** Incoming voice frames, kept apart from [events] so they cannot crowd out chat traffic. */
    val audioFrames: Flow<WsEvent.AudioFrameReceived>

    val connectionState: StateFlow<ConnectionState>

    fun sendMessage(conversationType: ConversationType, targetId: Long, text: String): Boolean
    fun editMessage(messageId: Long, text: String): Boolean
    fun deleteMessage(messageId: Long): Boolean
    fun markRead(conversationType: ConversationType, targetId: Long): Boolean
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

    override fun sendMessage(conversationType: ConversationType, targetId: Long, text: String) =
        webSocketClient.sendTextMessage(conversationType = conversationType, targetId = targetId, text = text)

    override fun editMessage(messageId: Long, text: String) = webSocketClient.editMessage(messageId, text)
    override fun deleteMessage(messageId: Long) = webSocketClient.deleteMessage(messageId)
    override fun markRead(conversationType: ConversationType, targetId: Long) =
        webSocketClient.markRead(conversationType, targetId)

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
