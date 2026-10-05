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
import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.data.model.RegisterRequestBody
import com.openmychat.mobile.data.model.RegistrationChallenge
import com.openmychat.mobile.data.model.RegistrationOutcome
import com.openmychat.mobile.data.model.ReportBody
import com.openmychat.mobile.data.repository.AccountRepository
import com.openmychat.mobile.data.repository.AttachmentRepository
import com.openmychat.mobile.data.repository.PickedFile
import com.openmychat.mobile.data.model.FilePolicy
import com.openmychat.mobile.data.model.FileUploadResponse
import com.openmychat.mobile.data.model.MessageType
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import java.io.File
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

    /** false — сокет закрыт: команды не уходят (send возвращает false). */
    var accepting = true

    fun emit(event: WsEvent) = check(_events.tryEmit(event))
    fun emitAudio(frame: WsEvent.AudioFrameReceived) = check(_audioFrames.tryEmit(frame))

    private fun record(command: String): Boolean {
        if (!accepting) return false
        sent += command
        return true
    }

    /** Ключи отправок в порядке ухода кадров `send_message`. */
    val sentClientMsgIds = mutableListOf<String>()

    override fun sendMessage(conversationType: ConversationType, targetId: Long, text: String, clientMsgId: String): Boolean {
        val written = record("send_message ${conversationType.value} $targetId $text")
        if (written) sentClientMsgIds += clientMsgId
        return written
    }
    /** Metadata of the last `send_message` with a file. */
    var lastAttachmentMetadata: JsonObject? = null

    override fun sendAttachment(
        conversationType: ConversationType,
        targetId: Long,
        text: String,
        type: MessageType,
        metadata: JsonObject,
        clientMsgId: String
    ): Boolean {
        val written = record("send_message ${type.value} ${conversationType.value} $targetId $text")
        if (written) {
            sentClientMsgIds += clientMsgId
            lastAttachmentMetadata = metadata
        }
        return written
    }
    override fun cancelMessage(clientMsgId: String) = record("cancel_message $clientMsgId")
    override fun editMessage(messageId: Long, text: String) = record("edit_message $messageId")
    override fun deleteMessage(messageId: Long) = record("delete_message $messageId")
    override fun markRead(conversationType: ConversationType, targetId: Long) =
        record("mark_read ${conversationType.value} $targetId")
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
}

open class FakeChatRepository(
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

    /** История вокруг сообщения (переход из поиска); null — «слишком давнее». */
    var around: List<Message>? = null
    val aroundRequests = mutableListOf<Long>()

    override suspend fun messagesAround(conversationType: ConversationType, targetId: Long, messageId: Long): List<Message>? {
        aroundRequests += messageId
        historyGate?.await()
        return around
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

/** Scriptable [AccountRepository]: registration, deletion, reports and blocks without a server. */
class FakeAccountRepository : AccountRepository {
    override val blocked = MutableStateFlow<List<BlockedUser>>(emptyList())

    var onRequest: suspend (RegisterRequestBody) -> RegistrationChallenge = { RegistrationChallenge("code_sent", "r-1", 600) }
    var onVerify: suspend (String, String) -> RegistrationOutcome = { _, _ -> RegistrationOutcome.Pending }
    var onDelete: suspend (String) -> Unit = {}
    var onReport: suspend (ReportBody) -> Unit = {}
    var onBlock: suspend (Long) -> Unit = {}
    var onUnblock: suspend (Long) -> Unit = {}
    var onRefreshBlocked: suspend () -> List<BlockedUser> = { blocked.value }

    val registrationRequests = mutableListOf<RegisterRequestBody>()
    val verifications = mutableListOf<Pair<String, String>>()
    val deletions = mutableListOf<String>()
    val reports = mutableListOf<ReportBody>()
    val blockCalls = mutableListOf<String>()

    override suspend fun requestRegistration(body: RegisterRequestBody): RegistrationChallenge {
        registrationRequests += body
        return onRequest(body)
    }

    override suspend fun verifyRegistration(registrationId: String, code: String): RegistrationOutcome {
        verifications += registrationId to code
        return onVerify(registrationId, code)
    }

    override suspend fun deleteAccount(password: String) {
        deletions += password
        onDelete(password)
    }

    override suspend fun report(body: ReportBody) {
        reports += body
        onReport(body)
    }

    override suspend fun block(userId: Long, name: String?) {
        blockCalls += "block $userId"
        onBlock(userId)
        if (blocked.value.none { it.id == userId }) blocked.value = blocked.value + BlockedUser(userId, name)
    }

    override suspend fun unblock(userId: Long) {
        blockCalls += "unblock $userId"
        onUnblock(userId)
        blocked.value = blocked.value.filter { it.id != userId }
    }

    override suspend fun refreshBlocked(): List<BlockedUser> = onRefreshBlocked().also { blocked.value = it }
}

/** Scriptable [AttachmentRepository]: picked files, policy, a gated upload and download. */
class FakeAttachmentRepository : AttachmentRepository {
    val picked = mutableMapOf<String, PickedFile>()
    var policyValue: FilePolicy? = null

    /** When set, uploads wait for it; otherwise they succeed at once. */
    var uploadGate: CompletableDeferred<FileUploadResponse>? = null

    /** The next upload fails with it (once). */
    var uploadFailure: Exception? = null
    val uploads = mutableListOf<PickedFile>()
    var uploadProgress: ((Float) -> Unit)? = null
    var cancelledUploads = 0
    private var nextId = 30L

    /** When set, downloads wait for it. */
    var downloadGate: CompletableDeferred<File>? = null
    var downloadFailure: Exception? = null
    val downloads = mutableListOf<Long>()
    var downloadProgress: ((Float?) -> Unit)? = null

    override suspend fun describe(uri: String): PickedFile? = picked[uri]
    override suspend fun policy(): FilePolicy? = policyValue

    override suspend fun upload(file: PickedFile, onProgress: (Float) -> Unit): FileUploadResponse {
        uploads += file
        uploadProgress = onProgress
        uploadFailure?.let {
            uploadFailure = null
            throw it
        }
        try {
            return uploadGate?.await() ?: uploaded(file)
        } catch (e: CancellationException) {
            cancelledUploads++
            throw e
        }
    }

    fun uploaded(file: PickedFile, id: Long = nextId++) = FileUploadResponse(
        id = id.toString(), originalName = file.name, storedFilename = "stored-$id", fileSize = file.size ?: 0,
        mimeType = file.mimeType ?: "application/octet-stream", url = "/api/files/download/$id"
    )

    override suspend fun download(fileId: Long, name: String, onProgress: (Float?) -> Unit): File {
        downloads += fileId
        downloadProgress = onProgress
        downloadFailure?.let {
            downloadFailure = null
            throw it
        }
        return downloadGate?.await() ?: File(name)
    }

    override fun thumbnailUrl(fileId: Long): String = "https://chat.example.com/api/files/thumb/$fileId?size=m"
}
