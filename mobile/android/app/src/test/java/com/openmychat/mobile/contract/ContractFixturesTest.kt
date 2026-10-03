package com.openmychat.mobile.contract

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.core.network.WsEventParser
import com.openmychat.mobile.core.network.WsFrame
import com.openmychat.mobile.data.model.Announcement
import com.openmychat.mobile.data.model.ApiErrorBody
import com.openmychat.mobile.data.model.AuthSuccessResponse
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.notifications.PushPayload
import com.openmychat.mobile.data.realtime.ConversationRef
import com.openmychat.mobile.data.model.DeviceClaimRequest
import com.openmychat.mobile.data.model.DeviceClaimResponse
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.model.FilePolicy
import com.openmychat.mobile.data.model.FileUploadResponse
import com.openmychat.mobile.data.model.KnockRequest
import com.openmychat.mobile.data.model.KnockResponse
import com.openmychat.mobile.data.model.LoginRequest
import com.openmychat.mobile.data.model.LogoutResponse
import com.openmychat.mobile.data.model.MeResponse
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.RefreshResponse
import com.openmychat.mobile.data.model.SyncPage
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.testing.TestSessions
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.reflect.KClass

/**
 * Cross-platform contract parity: every fixture listed in `mobile/contracts/fixtures/manifest.json`
 * (real server responses and frames) must decode with this client's DTOs and WebSocket parser.
 * The manifest is walked, not a fixed list, so a new fixture is covered the moment it lands.
 */
class ContractFixturesTest {

    /** Same configuration as [ApiClient]'s decoder. */
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
    }

    private val fixturesDir: File = locateFixtures()
    private val manifest: JsonObject = json.parseToJsonElement(File(fixturesDir, "manifest.json").readText()).jsonObject

    /** DTO the client uses for each successful route (method + path as written in the manifest). */
    private val successDecoders: Map<String, (String) -> Any> = mapOf(
        "GET /api/announcements" to { body -> json.decodeFromString<List<Announcement>>(body) },
        "POST /api/auth/device/claim" to { body -> json.decodeFromString<DeviceClaimResponse>(body) },
        "POST /api/auth/knock" to { body -> json.decodeFromString<KnockResponse>(body) },
        "POST /api/auth/login" to { body -> json.decodeFromString<AuthSuccessResponse>(body) },
        "POST /api/auth/logout" to { body -> json.decodeFromString<LogoutResponse>(body) },
        "GET /api/auth/me" to { body -> json.decodeFromString<MeResponse>(body) },
        "POST /api/auth/refresh" to { body -> json.decodeFromString<RefreshResponse>(body) },
        "GET /api/channels" to { body -> json.decodeFromString<List<Channel>>(body) },
        "GET /api/conversations/direct" to { body -> json.decodeFromString<List<DirectConversation>>(body) },
        "GET /api/files/policy" to { body -> json.decodeFromString<FilePolicy>(body) },
        "POST /api/files/upload" to { body -> json.decodeFromString<FileUploadResponse>(body) },
        "GET /api/messages" to { body -> json.decodeFromString<List<Message>>(body) },
        "GET /api/messages/channels/{id}" to { body -> json.decodeFromString<List<Message>>(body) },
        "GET /api/messages/direct/{id}" to { body -> json.decodeFromString<List<Message>>(body) },
        "POST /api/messages/channels/{id}" to { body -> json.decodeFromString<Message>(body) },
        "POST /api/messages/direct/{id}" to { body -> json.decodeFromString<Message>(body) },
        "GET /api/sync" to { body -> json.decodeFromString<SyncPage>(body) },
        "GET /api/users" to { body -> json.decodeFromString<List<User>>(body) },
        "GET /api/users/{id}" to { body -> json.decodeFromString<User>(body) },
        // Ответ на загрузку и удаление аватара — полная запись пользователя.
        "PUT /api/users/avatar" to { body -> json.decodeFromString<User>(body) },
        // Регистрация push-токена на Android не реализована (FCM-клиент — задача волны 3, контракт push.md):
        // пока проверяем только, что ответ — объект JSON, а не мусор.
        "POST /api/devices/push-token" to { body -> json.parseToJsonElement(body).jsonObject },
        "DELETE /api/devices/push-token" to { body -> json.parseToJsonElement(body).jsonObject }
    )

    /** Event each server frame type must become; null = documented frame the client ignores on purpose. */
    private val wsExpectations: Map<String, KClass<out WsEvent>?> = mapOf(
        "auth_success" to WsEvent.AuthSuccess::class,
        "auth_error" to WsEvent.AuthError::class,
        "server_disconnect" to WsEvent.ServerDisconnect::class,
        "new_message" to WsEvent.NewMessage::class,
        "direct_message" to WsEvent.NewMessage::class,
        "channel_message" to WsEvent.NewMessage::class,
        "message_status_updated" to WsEvent.MessageStatusUpdated::class,
        "messages_read" to WsEvent.MessagesRead::class,
        "message_updated" to WsEvent.MessageUpdated::class,
        "message_deleted" to WsEvent.MessageDeleted::class,
        "user_typing" to WsEvent.UserTyping::class,
        "user_status_changed" to WsEvent.UserStatusChanged::class,
        "channel_created" to WsEvent.ChannelCreated::class,
        "channel_deleted" to WsEvent.ChannelDeleted::class,
        "new_announcement" to WsEvent.NewAnnouncement::class,
        "announcement_acknowledged" to WsEvent.AnnouncementAcknowledged::class,
        "call_offer" to WsEvent.CallOffer::class,
        "call_answer" to WsEvent.CallAnswer::class,
        "call_rejected" to WsEvent.CallRejected::class,
        "call_end" to WsEvent.CallEnd::class,
        "call_denied" to WsEvent.CallDenied::class,
        "call_unavailable" to WsEvent.CallUnavailable::class,
        "wake_ring" to WsEvent.WakeRing::class,
        "wake_sent" to WsEvent.WakeSent::class,
        "wake_error" to WsEvent.WakeError::class,
        "wake_state" to WsEvent.WakeState::class,
        "error" to WsEvent.GenericError::class,
        // Audio is relayed as binary PCM frames, so WebRTC ICE candidates are not used on Android.
        "ice_candidate" to null,
        // The directory is loaded on demand; live roster updates are not shown on mobile yet.
        "user_created" to null,
        "user_updated" to null,
        // Echo of cancel_message (G9). Android does not cancel sends yet; the send queue (Task 15) maps it.
        "message_cancelled" to null,
        "conversation_read" to WsEvent.ConversationRead::class
    )

    @Test
    fun everyFixtureFileIsListedInTheManifest() {
        val onDisk = fixturesDir.walkTopDown()
            .filter { it.isFile && it.extension == "json" && it.name != "manifest.json" }
            .map { it.relativeTo(fixturesDir).invariantSeparatorsPath }
            .filterNot { it.startsWith("reducers/") } // client reducer vectors, not server responses (fixtures/README.md)
            .filterNot { it.startsWith("notify/") } // векторы «кому уведомление»: решает сервер (поле notify), Android его не повторяет
            .toSet()
        assertTrue("no fixtures found in $fixturesDir", onDisk.isNotEmpty())
        assertEquals("fixtures missing from manifest.json", emptySet<String>(), onDisk - manifest.keys)
        assertEquals("manifest.json lists files that do not exist", emptySet<String>(), manifest.keys - onDisk)
    }

    @Test
    fun everyFixtureInTheManifestDecodes() {
        val failures = mutableListOf<String>()
        manifest.forEach { (file, entryElement) ->
            val entry = entryElement.jsonObject
            val body = File(fixturesDir, file).readText()
            try {
                when (val kind = entry.string("kind")) {
                    "http" -> decodeHttp(entry, body)
                    "ws" -> decodeWs(entry, body)
                    "push" -> decodePush(entry, body)
                    else -> error("unknown fixture kind $kind")
                }
            } catch (failure: Throwable) {
                failures += "$file: ${failure::class.simpleName}: ${failure.message}"
            }
        }
        assertTrue("undecodable contract fixtures:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun webSocketFixturesCarryTheContractedValues() {
        assertEquals("6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b", (wsEvent("direct_message.json") as WsEvent.NewMessage).message.clientMsgId)
        assertEquals("2", (wsEvent("announcement_acknowledged.json") as WsEvent.AnnouncementAcknowledged).announcementId)
        assertEquals(1_790_931_600_000L, (wsEvent("wake_ring.json") as WsEvent.WakeRing).at)
        assertEquals(1_790_931_660_000L, (wsEvent("wake_sent.json") as WsEvent.WakeSent).retryAt)
        val idle = wsEvent("wake_state.idle.json") as WsEvent.WakeState
        assertEquals(null, idle.targetUserId)
        assertEquals(0L, idle.retryAt)
        val deleted = wsEvent("message_deleted.direct.json") as WsEvent.MessageDeleted
        assertEquals(8L, deleted.messageId)
        assertEquals(3L, deleted.targetId)
        val status = wsEvent("message_status_updated.reconnect.json") as WsEvent.MessageStatusUpdated
        // Recaptured with the Task 16 delivery fixtures (3a68ec8): the reconnect status now refers to message 13.
        assertEquals(13L, status.messageId)
        assertEquals("delivered", status.status)
        assertEquals("connection_lost", (wsEvent("call_end.connection_lost.json") as WsEvent.CallEnd).reason)
        assertEquals("MUST_CHANGE_PASSWORD", (wsEvent("auth_error.must_change_password.json") as WsEvent.AuthError).code)
        assertEquals("alice", (wsEvent("auth_success.json") as WsEvent.AuthSuccess).user.username)
        assertEquals(false, (wsEvent("direct_message.json") as WsEvent.NewMessage).notify)
        val direct = wsEvent("conversation_read.direct.json") as WsEvent.ConversationRead
        assertEquals(ConversationType.DIRECT, direct.conversationType)
        assertTrue(direct.messageIds.isNotEmpty())
        assertEquals(null, direct.lastReadId)
        val channel = wsEvent("conversation_read.channel.json") as WsEvent.ConversationRead
        assertEquals(ConversationType.CHANNEL, channel.conversationType)
        assertEquals(3L, channel.targetId)
        assertEquals(9L, channel.lastReadId)
        assertTrue(channel.messageIds.isEmpty())
    }

    /** Data-push FCM разбирается тем же кодом, что будет в обработчике сервиса (MessageNotifier.onPush). */
    @Test
    fun pushFixturesDecode() {
        fun fcm(name: String): Map<String, String> =
            json.parseToJsonElement(File(fixturesDir, "push/$name").readText()).jsonObject["message"]!!.jsonObject["data"]!!.jsonObject
                .mapValues { it.value.jsonPrimitive.content }
        assertEquals(PushPayload.Read(ConversationRef(ConversationType.DIRECT, 2)), PushPayload.parse(fcm("fcm.read.json")))
        assertEquals(PushPayload.NewMessage(ConversationRef(ConversationType.DIRECT, 2), 13), PushPayload.parse(fcm("fcm.message.direct.json")))
        assertTrue(PushPayload.parse(fcm("fcm.message.channel.json")) is PushPayload.NewMessage)
        assertTrue(PushPayload.parse(fcm("fcm.call.json")) is PushPayload.Call)
    }

    /** The real [ApiClient] request methods must read the recorded responses, not just the DTOs. */
    @Test
    fun apiClientReadsTheRecordedResponses() = runBlocking {
        val routes = mapOf(
            "GET /api/auth/me" to "http/auth.me.json",
            "POST /api/auth/refresh" to "http/auth.refresh.json",
            "POST /api/auth/login" to "http/auth.login.json",
            "POST /api/auth/knock" to "http/auth.knock-paired.json",
            "POST /api/auth/device/claim" to "http/auth.device-claim.json",
            "GET /api/conversations/direct" to "http/conversations.direct.json",
            "GET /api/channels" to "http/channels.list.json",
            "GET /api/messages/direct/3" to "http/messages.direct-page.json",
            "GET /api/messages/channels/3" to "http/messages.channel-page.json",
            "GET /api/announcements" to "http/announcements.list.json",
            "GET /api/files/policy" to "http/files.policy.json"
        )
        val sessionManager = TestSessions.authenticated()
        val apiClient = ApiClient(sessionManager, fixtureClient(routes))
        val failures = mutableListOf<String>()
        suspend fun check(name: String, block: suspend () -> Unit) {
            try {
                block()
            } catch (failure: Throwable) {
                failures += "$name: ${failure::class.simpleName}: ${failure.message}"
            }
        }

        check("getMe") { assertEquals("alice", apiClient.getMe().username) }
        check("refreshToken") { assertTrue(apiClient.refreshToken().token.isNotBlank()) }
        check("login") { assertEquals("alice", apiClient.login(LoginRequest("alice", "pw")).user.username) }
        check("knock") { assertEquals("paired", apiClient.knock(KnockRequest(deviceId = "d")).status) }
        check("claimDevice") { assertTrue(apiClient.claimDevice(DeviceClaimRequest("d", "s")).claimed) }
        check("getDirectConversations") { assertTrue(apiClient.getDirectConversations().isNotEmpty()) }
        check("getChannels") { assertTrue(apiClient.getChannels().isNotEmpty()) }
        check("getDirectMessages") { assertTrue(apiClient.getDirectMessages(3).isNotEmpty()) }
        check("getChannelMessages") { assertTrue(apiClient.getChannelMessages(3).isNotEmpty()) }
        check("getAnnouncements") { assertTrue(apiClient.getAnnouncements().isNotEmpty()) }
        check("getFilePolicy") { assertTrue(apiClient.getFilePolicy().enabled) }

        assertTrue("ApiClient cannot read recorded responses:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    private fun decodeHttp(entry: JsonObject, body: String) {
        val status = entry.string("status").toInt()
        if (status >= 400) {
            val error = json.decodeFromString<ApiErrorBody>(body)
            check(error.error.isNotBlank()) { "error body without a message" }
            return
        }
        val route = "${entry.string("method")} ${entry.string("path")}"
        val decoder = successDecoders[route] ?: error("no client DTO mapped for $route")
        decoder(body)
    }

    /**
     * Push-уведомления сервера (только идентификаторы, без текста — mobile/contracts/push.md). Приёмник FCM на Android
     * ещё не написан, поэтому здесь проверяется форма полезной нагрузки, которую он будет разбирать.
     */
    private fun decodePush(entry: JsonObject, body: String) {
        val provider = entry.string("provider")
        val payload = json.parseToJsonElement(body).jsonObject
        when (provider) {
            "fcm" -> {
                val data = payload["message"]?.jsonObject?.get("data")?.jsonObject ?: error("fcm: нет message.data")
                val type = data["type"]?.jsonPrimitive?.content
                check(PushPayload.parse(data.mapValues { it.value.jsonPrimitive.content }) != null) { "fcm: push \"$type\" не разобран" }
            }
            "apns" -> check(payload.isNotEmpty()) { "apns: пустая полезная нагрузка" }
            else -> error("неизвестный провайдер push \"$provider\"")
        }
    }

    private fun decodeWs(entry: JsonObject, body: String) {
        val type = entry.string("event")
        check(type in wsExpectations) { "no expectation for server frame '$type'; map it to a WsEvent or ignore it explicitly" }
        val expected = wsExpectations[type]
        when (val frame = WsEventParser.parse(body)) {
            is WsFrame.Event -> check(expected != null && expected.isInstance(frame.event)) {
                "'$type' became ${frame.event::class.simpleName}, expected ${expected?.simpleName ?: "Ignored"}"
            }
            is WsFrame.Ignored -> check(expected == null) { "'$type' was ignored, expected ${expected?.simpleName}" }
            is WsFrame.Unknown -> error("'$type' is unknown to the parser")
        }
    }

    private fun wsEvent(name: String): WsEvent {
        val frame = WsEventParser.parse(File(fixturesDir, "ws/$name").readText())
        return (frame as? WsFrame.Event)?.event ?: throw AssertionError("ws/$name did not become an event: $frame")
    }

    private fun fixtureClient(routes: Map<String, String>): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            val request = chain.request()
            val route = "${request.method} ${request.url.encodedPath}"
            val file = routes[route] ?: error("Unexpected request $route")
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(File(fixturesDir, file).readText().toResponseBody())
                .build()
        }
        .build()

    private fun JsonObject.string(key: String): String =
        this[key]?.jsonPrimitive?.content ?: error("manifest entry without '$key'")

    private fun locateFixtures(): File {
        val start = File(requireNotNull(System.getProperty("user.dir")))
        return generateSequence(start) { it.parentFile }
            .flatMap { sequenceOf(File(it, "contracts/fixtures"), File(it, "mobile/contracts/fixtures")) }
            .firstOrNull { File(it, "manifest.json").isFile }
            ?: error("mobile/contracts/fixtures/manifest.json not found above $start")
    }
}
