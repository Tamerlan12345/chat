package com.openmychat.mobile.data.push

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.AuthContext
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.notifications.ConversationReadBus
import com.openmychat.mobile.data.notifications.MessageNotifier
import com.openmychat.mobile.data.notifications.NotificationSink
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.data.realtime.ConversationRef
import com.openmychat.mobile.data.realtime.PresenceController
import com.openmychat.mobile.data.repository.DefaultSessionRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.TestSessions
import com.openmychat.mobile.testing.jwt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Decision P: push through FCM, ids only. The token is registered with the server's push-token API
 * for the signed-in account; a pushed message is fetched from our server and shown by the app; with
 * no Firebase configuration (no google-services.json) push is simply off and nothing is sent.
 */
class PushTest {

    private val session = TestSessions.authenticated(jwt(1))
    private val requests = LinkedBlockingQueue<Pair<String, String>>()
    private val answers = CopyOnWriteArrayList<Pair<String, Pair<Int, String>>>()
    private val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher())

    private val api = ApiClient(session, OkHttpClient.Builder().addInterceptor { chain ->
        val request: Request = chain.request()
        val path = request.url.encodedPath + (request.url.encodedQuery?.let { "?$it" } ?: "")
        requests += "${request.method} $path" to Buffer().also { request.body?.writeTo(it) }.readUtf8()
        val (code, body) = answers.firstOrNull { path.startsWith(it.first) }?.second ?: (200 to """{"registered":true,"push_enabled":true}""")
        Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("x").body(body.toResponseBody()).build()
    }.build())

    @After
    fun stop() = scope.cancel()

    private class Tokens(var token: String?) : PushTokenSource {
        override suspend fun currentToken(): String? = token
    }

    private fun next(): Pair<String, String> = requests.poll(5, TimeUnit.SECONDS) ?: error("no request")

    // ── registration ─────────────────────────────────────────────────────────────────────────

    @Test
    fun theTokenIsRegisteredForTheSignedInAccountAndThisDevice() = runBlocking {
        val registrar = PushRegistrar(Tokens("fcm-token-0123456789abcdefghij"), api, session, scope)

        registrar.start()

        val (path, body) = next()
        assertEquals("POST /api/devices/push-token", path)
        val json = Json.parseToJsonElement(body).jsonObject
        assertEquals("android", json["platform"]?.jsonPrimitive?.content)
        assertEquals("fcm-token-0123456789abcdefghij", json["token"]?.jsonPrimitive?.content)
        assertEquals(session.deviceId, json["device_id"]?.jsonPrimitive?.content)
        assertTrue("an app version the server accepts", Regex("[0-9A-Za-z._+-]{1,32}").matches(json["app_version"]!!.jsonPrimitive.content))
    }

    @Test
    fun withoutFirebaseConfigurationPushIsOffAndNothingIsSent() = runBlocking {
        PushRegistrar(Tokens(null), api, session, scope).start()
        assertNull(requests.poll(300, TimeUnit.MILLISECONDS))
    }

    @Test
    fun aNewTokenIsRegisteredOnlyWhileSignedIn() = runBlocking {
        val registrar = PushRegistrar(Tokens(null), api, session, scope)
        registrar.onNewToken("fcm-token-rotated-0123456789")
        assertEquals("POST /api/devices/push-token", next().first)

        session.clearSession()
        registrar.onNewToken("fcm-token-rotated-again-0123456")
        assertNull("signed out: nobody to register it for", requests.poll(300, TimeUnit.MILLISECONDS))
    }

    @Test
    fun aSignInRegistersAgain() = runBlocking {
        session.clearSession()
        PushRegistrar(Tokens("fcm-token-0123456789abcdefghij"), api, session, scope).start()
        assertNull(requests.poll(300, TimeUnit.MILLISECONDS))

        session.saveAuthSuccess(com.openmychat.mobile.data.model.User(id = 2, username = "carol", fullName = "Кэрол"), jwt(2))
        assertEquals("POST /api/devices/push-token", next().first)
    }

    // ── an incoming push ─────────────────────────────────────────────────────────────────────

    private class Sink : NotificationSink {
        val log = CopyOnWriteArrayList<String>()
        override fun show(conversation: ConversationRef, title: String, text: String, chatTitle: String) {
            log += "show ${conversation.type.value}-${conversation.targetId} $title: $text"
        }
        override fun cancel(conversation: ConversationRef) {
            log += "cancel ${conversation.type.value}-${conversation.targetId}"
        }
        override fun cancelAll() {
            log += "cancel all"
        }
    }

    private val realtime = FakeRealtimeRepository()
    private val sink = Sink()
    private val registry = ActiveConversationRegistry()
    private val notifier = MessageNotifier(
        realtime, sink, ConversationReadBus(), registry,
        PresenceController(realtime, scope, registry, AuthContext()), DefaultSessionRepository(session), scope
    )
    private val handler = PushMessageHandler(notifier, api)

    private fun messagePush(id: Long, type: String = "direct", target: Long = 5) =
        mapOf("type" to "message", "conversationType" to type, "targetId" to "$target", "messageId" to "$id")

    private fun record(id: Long, text: String, sender: Long = 5, senderName: String = "Иванов") =
        """{"id":$id,"conversation_type":"direct","target_id":1,"sender_id":$sender,"sender_name":"$senderName","text":"$text","type":"text","created_at":"2026-10-07T09:00:00.000Z"}"""

    @Test
    fun aPushedMessageIsFetchedFromOurServerAndShownWithItsSenderAndText() = runBlocking {
        answers += "/api/messages/direct/5" to (200 to "[${record(41, "Привет из push")}]")

        withTimeout(5_000) { handler.handle(messagePush(41)) }

        val (path, _) = next()
        assertTrue(path, path.startsWith("GET /api/messages/direct/5?") && "afterId=40" in path)
        assertEquals(listOf("show direct-5 Иванов: Привет из push"), sink.log)
    }

    @Test
    fun aMessageDeletedBeforeTheFetchShowsNothing() = runBlocking {
        answers += "/api/messages/direct/5" to (200 to "[]")
        withTimeout(5_000) { handler.handle(messagePush(41)) }
        assertEquals(emptyList<String>(), sink.log)
    }

    @Test
    fun whenTheFetchFailsOnlyTheGenericTextIsShown() = runBlocking {
        answers += "/api/messages/direct/5" to (503 to """{"error":"busy"}""")
        withTimeout(5_000) { handler.handle(messagePush(41)) }
        assertEquals(listOf("show direct-5 CentyChat: Новое сообщение"), sink.log)
    }

    @Test
    fun aMessageAlreadyReceivedOverTheSocketIsNotFetchedNorShownAgain() = runBlocking {
        realtime.emit(WsEvent.NewMessage(Message(id = 41, targetId = 1, senderId = 5, text = "уже здесь", createdAt = "2026-10-07T09:00:00Z", senderName = "Иванов"), notify = false))
        withTimeout(5_000) { handler.handle(messagePush(41)) }
        assertNull(requests.poll(300, TimeUnit.MILLISECONDS))
        assertEquals(emptyList<String>(), sink.log)
    }

    @Test
    fun aReadPushDismissesTheChatsNotification() = runBlocking {
        withTimeout(5_000) { handler.handle(mapOf("type" to "read", "conversationType" to "channel", "targetId" to "7")) }
        assertEquals(listOf("cancel channel-7"), sink.log)
    }

    @Test
    fun aPayloadWithAnythingButIdsIsStillReadOnlyForItsIds() = runBlocking {
        answers += "/api/messages/channels/9" to (200 to "[]")
        // A text in the payload is never shown: the app shows only what it fetched itself.
        withTimeout(5_000) { handler.handle(messagePush(50, "channel", 9) + ("text" to "подмена")) }
        assertTrue(sink.log.none { "подмена" in it })
        assertEquals(ConversationType.CHANNEL.value, "channel")
    }
}
