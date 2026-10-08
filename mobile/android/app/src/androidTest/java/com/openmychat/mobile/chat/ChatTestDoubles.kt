package com.openmychat.mobile.chat

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.core.session.SessionStorageState
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.model.Message
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import com.openmychat.mobile.data.delivery.DeliveryBackend
import com.openmychat.mobile.data.delivery.DeliveryEngine
import com.openmychat.mobile.data.delivery.HttpOutcome
import com.openmychat.mobile.data.delivery.RealtimeDeliveryLink
import com.openmychat.mobile.data.delivery.SyncOutcome
import com.openmychat.mobile.data.delivery.UnreadSnapshot
import com.openmychat.mobile.data.delivery.store.DeliveryDatabase
import com.openmychat.mobile.data.delivery.store.RoomDeliveryStore
import com.openmychat.mobile.data.delivery.store.RoomUploadStore
import com.openmychat.mobile.data.repository.UnavailableAttachments
import com.openmychat.mobile.features.chat.AttachmentSends
import com.openmychat.mobile.features.chat.ChatProjection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
    override val deliveryFrames: Flow<JsonObject> = emptyFlow()
    override fun sendFrame(frame: JsonObject) = true
    override fun restartLink() = Unit
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

/** No server behind the delivery engine: empty sync pages, the fixed history, nothing posted. */
class StaticDeliveryBackend(private val history: List<Message>) : DeliveryBackend {
    override suspend fun sync(cursor: String?, limit: Int): SyncOutcome = SyncOutcome.Page(buildJsonObject {
        put("messages", JsonArray(emptyList()))
        put("next_cursor", "c1")
        put("has_more", false)
    })
    override suspend fun history(conversation: String): List<JsonObject> = history.map(ChatProjection::record)
    override suspend fun unreadSnapshot() = UnreadSnapshot(emptyMap(), emptyMap())
    override suspend fun post(path: String, body: JsonObject) = HttpOutcome(0, null)
}

/** The delivery core of a screen test: the real engine over an in-memory Room database. */
class TestDelivery(realtime: RealtimeRepository, session: SessionRepository, history: List<Message>) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val database = Room.inMemoryDatabaseBuilder(
        InstrumentationRegistry.getInstrumentation().targetContext, DeliveryDatabase::class.java
    ).build()
    val engine = DeliveryEngine(scope, RoomDeliveryStore(database.dao()), RealtimeDeliveryLink(realtime, session), StaticDeliveryBackend(history)).also { it.start() }
    val sends = AttachmentSends(scope, RoomUploadStore(database.dao()), UnavailableAttachments, engine)
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
