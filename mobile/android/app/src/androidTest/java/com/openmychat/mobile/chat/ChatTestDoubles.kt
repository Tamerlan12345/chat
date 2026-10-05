package com.openmychat.mobile.chat

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.core.session.SessionStorageState
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import kotlinx.serialization.json.JsonObject
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.repository.ChatRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.ui.navigation.AuthenticatedRouteState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.map

/** A server that answers the chat with a fixed history and accepts every frame. For ChatViewModel on a device. */
class StaticChatRepository(private val history: List<Message>) : ChatRepository {
    override suspend fun directConversations(): List<DirectConversation> = emptyList()
    override suspend fun channels(): List<Channel> = emptyList()
    override suspend fun refreshServerInfo() = Unit
    override suspend fun messages(conversationType: ConversationType, targetId: Long): List<Message> = history
}

class ConnectedRealtimeRepository : RealtimeRepository {
    override val events: Flow<WsEvent> = emptyFlow()
    override val audioFrames: Flow<WsEvent.AudioFrameReceived> = emptyFlow()
    override val connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Connected)
    override fun sendMessage(conversationType: ConversationType, targetId: Long, text: String, clientMsgId: String) = true
    override fun sendAttachment(
        conversationType: ConversationType,
        targetId: Long,
        text: String,
        type: MessageType,
        metadata: JsonObject,
        clientMsgId: String
    ) = true
    override fun cancelMessage(clientMsgId: String) = true
    override fun editMessage(messageId: Long, text: String) = true
    override fun deleteMessage(messageId: Long) = true
    override fun markRead(conversationType: ConversationType, targetId: Long) = true
    override fun sendViewing(conversation: Pair<ConversationType, Long>?) = true
    override fun sendTyping(conversationType: ConversationType, targetId: Long, isTyping: Boolean) = true
    override fun sendPresence(state: String) = true
    override fun sendCustomStatus(state: String, customStatus: String?) = true
    override fun setDnd(enabled: Boolean) = true
    override fun sendWake(targetUserId: Long) = true
    override fun sendCallOffer(targetUserId: Long) = true
    override fun sendCallAnswer(targetUserId: Long) = true
    override fun sendCallRejected(targetUserId: Long, reason: String?) = true
    override fun sendCallEnd(targetUserId: Long, reason: String?) = true
    override fun sendAudioFrame(targetUserId: Long, pcmSamples: ShortArray) = true
}

class SignedInSessionRepository(userId: Long) : SessionRepository {
    override val token = MutableStateFlow<String?>("token")
    override val currentUser = MutableStateFlow<User?>(User(id = userId, username = "me", fullName = "Я"))
    override val storageState = MutableStateFlow(SessionStorageState.AVAILABLE)
    override val mustChangePassword = MutableStateFlow(false)
    override val routeStates: Flow<AuthenticatedRouteState> = token.map { routeState() }
    override val currentUserId: Long? get() = currentUser.value?.id
    override val isAdmin: Boolean = false
    override val messageEditWindowMinutes: String = "60"
    override val messageDeleteWindowMinutes: String = "60"
    override fun routeState() = AuthenticatedRouteState(token.value, currentUser.value != null, storageState.value)
}
