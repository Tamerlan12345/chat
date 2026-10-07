package com.openmychat.mobile.testing

import com.openmychat.mobile.data.delivery.DeliveryBackend
import com.openmychat.mobile.data.delivery.DeliveryEngine
import com.openmychat.mobile.data.delivery.DeliveryRuntime
import com.openmychat.mobile.data.delivery.HttpOutcome
import com.openmychat.mobile.data.delivery.RealtimeDeliveryLink
import com.openmychat.mobile.data.delivery.SyncOutcome
import com.openmychat.mobile.data.delivery.UnreadSnapshot
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.repository.AttachmentRepository
import com.openmychat.mobile.data.repository.ChatRepository
import com.openmychat.mobile.data.repository.UnavailableAttachments
import com.openmychat.mobile.features.chat.AttachmentSends
import com.openmychat.mobile.features.chat.ChatProjection
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The server side of the delivery engine in tests: `/sync` answers an empty page with a fresh
 * cursor unless [syncAnswers] says otherwise, history comes from [chat], `POST` from [postAnswer].
 */
class FakeDeliveryBackend(var chat: ChatRepository? = null) : DeliveryBackend {
    val syncRequests = mutableListOf<String?>()
    val syncAnswers = ArrayDeque<SyncOutcome>()
    private var cursors = 0

    val historyRequests = mutableListOf<String>()
    var unread = UnreadSnapshot(emptyMap(), emptyMap())

    val posts = mutableListOf<Pair<String, JsonObject>>()

    /** When set, `POST`s wait for it (a slow network). */
    var postGate: CompletableDeferred<Unit>? = null
    var postAnswer: (String, JsonObject) -> HttpOutcome = { _, _ -> HttpOutcome(0, null) }

    /** The account ([RequestOwner]) each request was made for (final review I4). */
    val syncOwners = mutableListOf<Long?>()
    val postOwners = mutableListOf<Long?>()
    val historyOwners = mutableListOf<Long?>()

    override suspend fun sync(cursor: String?, limit: Int): SyncOutcome {
        syncOwners += kotlinx.coroutines.currentCoroutineContext()[com.openmychat.mobile.core.network.RequestOwner]?.userId
        syncRequests += cursor
        return syncAnswers.removeFirstOrNull() ?: SyncOutcome.Page(page(emptyList(), "c${++cursors}"))
    }

    override suspend fun history(conversation: String): List<JsonObject> {
        historyOwners += kotlinx.coroutines.currentCoroutineContext()[com.openmychat.mobile.core.network.RequestOwner]?.userId
        historyRequests += conversation
        val repository = chat ?: return emptyList()
        val (type, id) = conversation.split(':')
        return repository.messages(ConversationType.fromValue(type), id.toLong()).map(ChatProjection::record)
    }

    override suspend fun unreadSnapshot(): UnreadSnapshot = unread

    override suspend fun post(path: String, body: JsonObject): HttpOutcome {
        postOwners += kotlinx.coroutines.currentCoroutineContext()[com.openmychat.mobile.core.network.RequestOwner]?.userId
        posts += path to body
        postGate?.await()
        return postAnswer(path, body)
    }

    companion object {
        fun page(messages: List<JsonObject>, cursor: String, hasMore: Boolean = false) = buildJsonObject {
            put("messages", JsonArray(messages))
            put("next_cursor", JsonPrimitive(cursor))
            put("has_more", hasMore)
        }
    }
}

/**
 * The process-wide delivery core over fakes, on the test's dispatcher and virtual clock: the
 * engine, the file queue and the runtime that starts them (as the app does at launch).
 */
class DeliveryHarness(
    val realtime: FakeRealtimeRepository,
    chat: ChatRepository?,
    val dispatcher: TestDispatcher,
    val session: FakeSessionRepository = FakeSessionRepository(),
    val uploadStore: InMemoryUploadStore = InMemoryUploadStore(),
    val store: InMemoryDeliveryStore = InMemoryDeliveryStore(uploadStore),
    files: AttachmentRepository = UnavailableAttachments
) {
    val scope = CoroutineScope(SupervisorJob() + dispatcher)
    val backend = FakeDeliveryBackend(chat)
    private val clock = { dispatcher.scheduler.currentTime }
    var flushesScheduled = 0
        private set
    /** What the runtime logged (failures nobody waits for). */
    val logged = mutableListOf<String>()
    /** Wired exactly as the app's DI does. */
    val runtime = DeliveryRuntime.create(
        scope, store, uploadStore, RealtimeDeliveryLink(realtime, session), backend, files, session, realtime,
        { flushesScheduled++ }, clock, { message, _ -> logged += message }
    )
    val engine: DeliveryEngine = runtime.engine
    val sends: AttachmentSends = runtime.sends

    init {
        runtime.start()
    }

    fun stop() = scope.cancel()
}
