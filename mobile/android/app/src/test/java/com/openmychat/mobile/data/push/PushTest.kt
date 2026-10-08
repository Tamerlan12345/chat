package com.openmychat.mobile.data.push

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.BearerCredentialsInterceptor
import com.openmychat.mobile.core.network.BoundCredentials
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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
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
import java.util.concurrent.CountDownLatch
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

    private var beforeRequest: (Request) -> Unit = {}

    private val api = ApiClient(session, OkHttpClient.Builder().addInterceptor { chain ->
        val request: Request = chain.request()
        beforeRequest(request)
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

    @Test
    fun sameAccountNewSignInRegistersAgainButRefreshDoesNot() = runBlocking {
        PushRegistrar(Tokens("fcm-token-same-account"), api, session, scope).start()
        next()
        val replacement = jwt(1, "second-sign-in")
        session.saveAuthSuccess(session.currentUser!!, replacement)
        assertEquals("POST /api/devices/push-token", next().first)
        assertTrue(session.replaceTokenIfCurrent(replacement, jwt(1, "refresh")))
        assertNull(requests.poll(300, TimeUnit.MILLISECONDS))
    }

    @Test
    fun delayedProviderLookupCannotOverwriteANewerCallback() = runBlocking {
        val lookup = CompletableDeferred<String?>()
        val registrar = PushRegistrar(object : PushTokenSource {
            override suspend fun currentToken() = lookup.await()
        }, api, session, scope)
        registrar.start()
        registrar.onNewToken("fcm-token-newer")
        assertTrue(next().second.contains("fcm-token-newer"))
        lookup.complete("fcm-token-older")
        assertNull("stale lookup must be discarded", requests.poll(300, TimeUnit.MILLISECONDS))
    }

    @Test
    fun providerCallbacksAreSentInOrderEvenWhenTheOlderRequestIsSlow() = runBlocking {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        beforeRequest = { request ->
            val body = Buffer().also { request.body?.writeTo(it) }.readUtf8()
            if (body.contains("fcm-token-older")) {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
            }
        }
        val registrar = PushRegistrar(Tokens(null), api, session, scope)
        try {
            registrar.onNewToken("fcm-token-older")
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            registrar.onNewToken("fcm-token-newer")
            assertNull("newer request waits for older request", requests.poll(300, TimeUnit.MILLISECONDS))
        } finally {
            release.countDown()
        }
        assertTrue(next().second.contains("fcm-token-older"))
        assertTrue(next().second.contains("fcm-token-newer"))
    }

    @Test
    fun accountSwitchDiscardsOldLookupAndBindsNewRequestToNewAccount() = runBlocking {
        val oldLookup = CompletableDeferred<String?>()
        var lookups = 0
        val owners = LinkedBlockingQueue<Pair<Long?, String?>>()
        beforeRequest = { request ->
            val credentials = request.tag(com.openmychat.mobile.core.network.BoundCredentials::class.java)
            owners += credentials?.owner to credentials?.token
        }
        val registrar = PushRegistrar(object : PushTokenSource {
            override suspend fun currentToken(): String? =
                if (++lookups == 1) oldLookup.await() else "fcm-token-current"
        }, api, session, scope)
        registrar.start()
        session.saveAuthSuccess(com.openmychat.mobile.data.model.User(id = 2, username = "carol", fullName = "Carol"), jwt(2))
        oldLookup.complete("fcm-token-stale")
        assertTrue(next().second.contains("fcm-token-current"))
        assertEquals(2L to jwt(2), owners.poll(5, TimeUnit.SECONDS))
        assertNull(requests.poll(300, TimeUnit.MILLISECONDS))
    }

    @Test
    fun accountSwitchBeforeBearerAttachmentDropsTheOldHttpRegistration() = runBlocking {
        assertAccountSwitchDuringHttpRegistration(blockBeforeBearer = true)
    }

    @Test
    fun accountSwitchAfterBearerAttachmentKeepsOldCredentialsAndSerializesNewRegistration() = runBlocking {
        assertAccountSwitchDuringHttpRegistration(blockBeforeBearer = false)
    }

    private fun assertAccountSwitchDuringHttpRegistration(blockBeforeBearer: Boolean) {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val attemptedOwners = CopyOnWriteArrayList<Long?>()
        val sent = LinkedBlockingQueue<Pair<String, String?>>()
        val blocker = Interceptor { chain ->
            val request = chain.request()
            val owner = request.tag(BoundCredentials::class.java)?.owner
            attemptedOwners += owner
            if (owner == 1L) {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
            }
            chain.proceed(request)
        }
        val bearer = BearerCredentialsInterceptor(
            tokenProvider = { session.token },
            trustedApiBaseUrlProvider = { session.serverUrl.toHttpUrl() },
            markMustChangePassword = { session.mustChangePassword = true }
        )
        val client = OkHttpClient.Builder().apply {
            if (blockBeforeBearer) addInterceptor(blocker)
            addInterceptor(bearer)
            if (!blockBeforeBearer) addInterceptor(blocker)
            // This terminal transport keeps the real request/credential pipeline entirely offline.
            addInterceptor { chain ->
                val request = chain.request()
                assertEquals("POST", request.method)
                assertEquals("/api/devices/push-token", request.url.encodedPath)
                val body = Buffer().also { request.body?.writeTo(it) }.readUtf8()
                val token = Json.parseToJsonElement(body).jsonObject["token"]!!.jsonPrimitive.content
                sent += token to request.header("Authorization")
                Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
                    .code(200).message("OK").body("{}".toResponseBody()).build()
            }
        }.build()
        val tokens = Tokens("fcm-for-account-a")
        val registrar = PushRegistrar(tokens, ApiClient(session, client), session, scope)
        try {
            registrar.start()
            assertTrue("account A HTTP call reached the latch", entered.await(5, TimeUnit.SECONDS))
            tokens.token = "fcm-for-account-b"
            session.saveAuthSuccess(com.openmychat.mobile.data.model.User(id = 2, username = "carol", fullName = "Carol"), jwt(2))
            assertNull("account B must wait for account A HTTP call", sent.poll(300, TimeUnit.MILLISECONDS))
            assertEquals(listOf(1L), attemptedOwners.toList())
        } finally {
            release.countDown()
        }
        if (!blockBeforeBearer) {
            assertEquals("fcm-for-account-a" to "Bearer ${jwt(1)}", sent.poll(5, TimeUnit.SECONDS))
        }
        assertEquals("fcm-for-account-b" to "Bearer ${jwt(2)}", sent.poll(5, TimeUnit.SECONDS))
        assertEquals(listOf(1L, 2L), attemptedOwners.toList())
        assertNull("no old registration may be sent with account B credentials", sent.poll(300, TimeUnit.MILLISECONDS))
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
