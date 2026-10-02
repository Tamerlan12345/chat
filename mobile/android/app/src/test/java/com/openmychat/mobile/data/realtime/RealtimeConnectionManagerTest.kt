package com.openmychat.mobile.data.realtime

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.repository.DefaultSessionRepository
import com.openmychat.mobile.testing.InMemorySharedPreferences
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RealtimeConnectionManagerTest {

    private val sessionManager = SessionManager(prefs = InMemorySharedPreferences(), isDebuggableBuild = false).apply {
        commitVerifiedServerEndpoint(validateServerEndpoint("https://chat.example").getOrThrow())
        saveAuthSuccess(User(id = 1, username = "alice", fullName = "Alice"), "token")
    }
    private val listeners = mutableListOf<Pair<WebSocket, WebSocketListener>>()
    private val client = WebSocketClient(sessionManager, webSocketFactory = { request, listener ->
        FakeSocket(request).also { listeners += it to listener }
    })
    private val scope = TestScope(UnconfinedTestDispatcher())
    private var verifications = 0
    private val manager = RealtimeConnectionManager(
        sessionRepository = DefaultSessionRepository(sessionManager),
        webSocketClient = client,
        scope = scope,
        sessionVerifier = { verifications++ }
    )

    @After
    fun tearDown() {
        manager.stop()
        scope.coroutineContext[Job]?.cancel()
    }

    private fun serverSays(text: String) {
        val (socket, listener) = listeners.last()
        listener.onOpen(socket, Response.Builder().request(socket.request()).protocol(Protocol.HTTP_1_1)
            .code(101).message("").build())
        listener.onMessage(socket, text)
    }

    @Test
    fun aRejectedTokenIsVerifiedOverHttpOnce() {
        manager.start()

        serverSays("""{"type":"auth_error","code":"INVALID_TOKEN","message":"bad"}""")

        assertEquals(1, verifications)
    }

    @Test
    fun transientRefusalsDoNotTriggerAVerification() {
        manager.start()

        serverSays("""{"type":"auth_error","code":"RATE_LIMITED","message":"later"}""")

        assertEquals(0, verifications)
    }

    @Test
    fun losingTheSessionDisconnects() {
        manager.start()
        assertEquals(ConnectionState.Connecting, client.connectionState.value)

        sessionManager.clearSession()

        assertEquals(ConnectionState.Disconnected, client.connectionState.value)
    }

    private class FakeSocket(private val request: Request) : WebSocket {
        override fun request(): Request = request
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean = true
        override fun send(bytes: ByteString): Boolean = true
        override fun close(code: Int, reason: String?): Boolean = true
        override fun cancel() = Unit
    }
}
