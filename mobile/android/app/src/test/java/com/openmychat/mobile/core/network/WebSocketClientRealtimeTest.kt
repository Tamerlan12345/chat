package com.openmychat.mobile.core.network

import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.testing.InMemorySharedPreferences
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import com.openmychat.mobile.testing.TestSessions

@OptIn(ExperimentalCoroutinesApi::class)
class WebSocketClientRealtimeTest {

    private val sessionManager = SessionManager(prefs = InMemorySharedPreferences(), serverEndpoint = TestSessions.CHAT_EXAMPLE).apply {
        saveAuthSuccess(User(id = 1, username = "alice", fullName = "Alice"), "token")
    }
    private val sockets = mutableListOf<FakeWebSocket>()
    private val listeners = mutableListOf<WebSocketListener>()
    private val client = WebSocketClient(
        sessionManager = sessionManager,
        webSocketFactory = { request, listener ->
            listeners += listener
            FakeWebSocket(request).also { sockets += it }
        }
    )

    private val listener get() = listeners.last()
    private val socket get() = sockets.last()

    private fun open() {
        listener.onOpen(socket, Response.Builder()
            .request(socket.request())
            .protocol(Protocol.HTTP_1_1)
            .code(101)
            .message("Switching Protocols")
            .build())
    }

    private fun receive(text: String) = listener.onMessage(socket, text)

    private fun messageJson(type: String, id: Long) = """
        {"type":"$type","message":{"id":$id,"conversation_type":"direct","target_id":1,"sender_id":2,
        "text":"hi","created_at":"2026-09-30T09:40:00.000Z"}}
    """.trimIndent()

    @Test
    fun theSameMessageDeliveredAsNewMessageAndDirectMessageIsEmittedOnce() {
        val scope = TestScope(UnconfinedTestDispatcher())
        val received = mutableListOf<WsEvent>()
        scope.launch { client.events.collect { received += it } }
        client.connect(scope)
        open()

        receive(messageJson("direct_message", 512))
        receive(messageJson("new_message", 512))
        receive(messageJson("new_message", 513))

        assertEquals(listOf(512L, 513L), received.filterIsInstance<WsEvent.NewMessage>().map { it.message.id })
        client.disconnect()
        scope.cancel()
    }

    @Test
    fun audioFramesTravelOnTheirOwnFlowAndNeverCrowdOutChatEvents() {
        val scope = TestScope(UnconfinedTestDispatcher())
        val chatEvents = mutableListOf<WsEvent>()
        val frames = mutableListOf<WsEvent.AudioFrameReceived>()
        scope.launch { client.events.collect { chatEvents += it } }
        scope.launch { client.audioFrames.collect { frames += it } }
        client.connect(scope)
        open()

        val frame = ByteArray(1028).also { it[3] = 2 }.toByteString()
        repeat(200) { listener.onMessage(socket, frame) }
        receive(messageJson("new_message", 600))

        assertEquals(200, frames.size)
        assertTrue(chatEvents.none { it is WsEvent.AudioFrameReceived })
        assertEquals(1, chatEvents.filterIsInstance<WsEvent.NewMessage>().size)
        client.disconnect()
        scope.cancel()
    }

    @Test
    fun connectionStateFollowsTheSocketAndAuthentication() {
        val scope = TestScope(UnconfinedTestDispatcher())
        assertEquals(ConnectionState.Disconnected, client.connectionState.value)

        client.connect(scope)
        assertEquals(ConnectionState.Connecting, client.connectionState.value)

        open()
        receive("""{"type":"auth_success","user":{"id":1,"username":"alice","full_name":"Alice"}}""")
        assertEquals(ConnectionState.Connected, client.connectionState.value)

        client.disconnect()
        assertEquals(ConnectionState.Disconnected, client.connectionState.value)
        scope.cancel()
    }

    @Test
    fun rejectedTokenClosesTheSocketAndStopsReconnecting() {
        val scope = TestScope(StandardTestDispatcher())
        client.connect(scope)
        open()

        receive("""{"type":"auth_error","code":"INVALID_TOKEN","message":"Недействительный токен авторизации"}""")
        listener.onClosed(socket, 4001, "Authentication timeout")
        scope.advanceTimeBy(120_000)
        scope.runCurrent()

        assertEquals(ConnectionState.Unauthorized("INVALID_TOKEN", "Недействительный токен авторизации"), client.connectionState.value)
        assertTrue("The rejected socket must be closed by the client", socket.closed)
        assertEquals("No reconnect loop with a rejected token", 1, sockets.size)
        scope.cancel()
    }

    @Test
    fun aNewTokenAfterRejectionCanConnectAgain() {
        val scope = TestScope(StandardTestDispatcher())
        client.connect(scope)
        open()
        receive("""{"type":"auth_error","code":"INVALID_TOKEN","message":"bad"}""")

        sessionManager.token = "fresh-token"
        client.connect(scope)

        assertEquals(2, sockets.size)
        assertEquals(ConnectionState.Connecting, client.connectionState.value)
        client.disconnect()
        scope.cancel()
    }

    @Test
    fun transientAuthRefusalsAreRetriedWithBackoff() {
        val scope = TestScope(StandardTestDispatcher())
        client.connect(scope)
        open()

        receive("""{"type":"auth_error","code":"TOO_MANY_SESSIONS","message":"Слишком много открытых окон"}""")
        listener.onClosed(socket, 1000, "")
        scope.advanceTimeBy(60_000)
        scope.runCurrent()

        assertEquals(2, sockets.size)
        client.disconnect()
        scope.cancel()
    }

    private fun TestScope.cancel() = coroutineContext[kotlinx.coroutines.Job]?.cancel()

    @Test
    fun theDeliveryEngineGetsEveryFrameAsSentInOrderAndEachSocketClose() {
        val scope = TestScope(UnconfinedTestDispatcher())
        val frames = mutableListOf<String>()
        scope.launch { client.deliveryFrames.collect { frames += it["type"].toString().trim('"') + (it["message"]?.let { m -> " " + (m as kotlinx.serialization.json.JsonObject)["id"] } ?: "") } }
        client.connect(scope)
        open()

        receive("""{"type":"auth_success","user":{"id":1,"username":"alice","full_name":"Alice"}}""")
        receive(messageJson("direct_message", 512))
        receive(messageJson("new_message", 512))
        listener.onFailure(socket, java.io.IOException("reset"), null)

        // Nothing is deduplicated for the engine: it merges repeated frames itself (delivery-state.md §7.7).
        assertEquals(listOf("auth_success", "direct_message 512", "new_message 512", "socket_closed"), frames)
        client.disconnect()
        scope.cancel()
    }

    private class FakeWebSocket(private val request: Request) : WebSocket {
        var closed = false
        override fun request(): Request = request
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean = true
        override fun send(bytes: ByteString): Boolean = true
        override fun close(code: Int, reason: String?): Boolean {
            closed = true
            return true
        }
        override fun cancel() = Unit
    }
}
