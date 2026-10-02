package com.openmychat.mobile.testing

import com.openmychat.mobile.core.audio.CallAudio
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.core.session.SessionStorageState
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.ChangePasswordResponse
import com.openmychat.mobile.data.repository.AuthRepository
import com.openmychat.mobile.data.repository.ChatRepository
import com.openmychat.mobile.data.repository.LoginResult
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.ui.navigation.AuthenticatedRouteState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map

class FakeRealtimeRepository : RealtimeRepository {
    private val _events = MutableSharedFlow<WsEvent>(extraBufferCapacity = 64)
    private val _audioFrames = MutableSharedFlow<WsEvent.AudioFrameReceived>(extraBufferCapacity = 64)
    override val events: Flow<WsEvent> = _events
    override val audioFrames: Flow<WsEvent.AudioFrameReceived> = _audioFrames
    override val connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Connected)

    /** Outgoing commands in order, e.g. "mark_read direct 7" or "call_end 7". */
    val sent = mutableListOf<String>()

    fun emit(event: WsEvent) = check(_events.tryEmit(event))
    fun emitAudio(frame: WsEvent.AudioFrameReceived) = check(_audioFrames.tryEmit(frame))

    private fun record(command: String): Boolean {
        sent += command
        return true
    }

    override fun sendMessage(conversationType: ConversationType, targetId: Long, text: String) =
        record("send_message ${conversationType.value} $targetId $text")
    override fun editMessage(messageId: Long, text: String) = record("edit_message $messageId")
    override fun deleteMessage(messageId: Long) = record("delete_message $messageId")
    override fun markRead(conversationType: ConversationType, targetId: Long) =
        record("mark_read ${conversationType.value} $targetId")
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
}

class FakeChatRepository(
    var direct: List<DirectConversation> = emptyList(),
    var channels: List<Channel> = emptyList(),
    var history: List<Message> = emptyList()
) : ChatRepository {
    var directConversationRequests = 0

    /** When set, every list request fails with it. */
    var failWith: Exception? = null

    override suspend fun directConversations(): List<DirectConversation> {
        directConversationRequests++
        failWith?.let { throw it }
        return direct
    }

    override suspend fun channels(): List<Channel> {
        failWith?.let { throw it }
        return channels
    }
    override suspend fun refreshServerInfo() = Unit
    /** When set, history requests wait for it (a slow network). */
    var historyGate: kotlinx.coroutines.CompletableDeferred<Unit>? = null

    /** When set, history requests fail with it. */
    var historyFailure: Exception? = null

    override suspend fun messages(conversationType: ConversationType, targetId: Long): List<Message> {
        historyGate?.await()
        historyFailure?.let { throw it }
        return history
    }
}

class FakeSessionRepository(userId: Long = ME) : SessionRepository {
    override val token = MutableStateFlow<String?>("token")
    override val currentUser = MutableStateFlow<User?>(User(id = userId, username = "me", fullName = "Me"))
    override val storageState = MutableStateFlow(SessionStorageState.AVAILABLE)
    override val mustChangePassword = MutableStateFlow(false)
    override val routeStates: Flow<AuthenticatedRouteState> = token.map { routeState() }
    override val currentUserId: Long? get() = currentUser.value?.id
    override val isAdmin: Boolean = false
    override val messageEditWindowMinutes: String = "60"
    override val messageDeleteWindowMinutes: String = "60"
    override fun routeState() = AuthenticatedRouteState(token.value, currentUser.value != null, storageState.value)

    companion object {
        const val ME = 1L
    }
}

class FakeLoginPreferences : com.openmychat.mobile.features.auth.LoginPreferences {
    override var lastUsername: String? = null
}

class FakeCallAudio : CallAudio {
    override var onFrameRecorded: ((ShortArray) -> Unit)? = null
    var started = 0
    var stopped = 0
    val played = mutableListOf<ShortArray>()

    override fun start(scope: CoroutineScope) {
        started++
    }

    override fun stop() {
        stopped++
    }

    override fun onIncomingAudioFrame(pcmSamples: ShortArray) {
        played += pcmSamples
    }

    override fun setMute(muted: Boolean) = Unit
    override fun setSpeakerphone(enabled: Boolean) = Unit
}

fun message(
    id: Long,
    from: Long,
    to: Long,
    type: ConversationType = ConversationType.DIRECT,
    text: String = "text $id"
) = Message(
    id = id,
    conversationType = type,
    targetId = to,
    senderId = from,
    text = text,
    createdAt = "2026-09-30T09:40:00.000Z"
)

/** Scriptable [AuthRepository]: each call runs the matching lambda, so tests can suspend or throw. */
class FakeAuthRepository : AuthRepository {
    override val mustChangePassword = MutableStateFlow(false)
    override val isPasswordChangeForced: Boolean get() = mustChangePassword.value
    override var hasSessionToken: Boolean = false

    var onKnock: suspend () -> Boolean = { false }
    var onCompanyName: suspend () -> String? = { null }
    var onLogin: suspend (String, String) -> LoginResult = { _, _ -> LoginResult.SUCCESS }
    val loginAttempts = mutableListOf<Pair<String, String>>()
    var knocks = 0

    override suspend fun knock(): Boolean {
        knocks++
        return onKnock()
    }

    override suspend fun companyName(): String? = onCompanyName()

    override suspend fun login(username: String, password: String): LoginResult {
        loginAttempts += username to password
        return onLogin(username, password)
    }

    override suspend fun changePassword(oldPassword: String, newPassword: String) =
        ChangePasswordResponse(success = true)

    override suspend fun logout() = Unit
}
