package com.openmychat.mobile.core.network

import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.testing.InMemorySharedPreferences
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import com.openmychat.mobile.testing.TestSessions

/**
 * The server answers TOO_MANY_SESSIONS / RATE_LIMITED with auth_error on an already open socket and
 * leaves it open. Each retry opens a new socket, so backoff must survive onOpen and only reset once
 * the server accepts the session.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class WebSocketClientBackoffTest {

    private val scope = TestScope(StandardTestDispatcher())
    private val sessionManager = SessionManager(prefs = InMemorySharedPreferences(), serverEndpoint = TestSessions.CHAT_EXAMPLE).apply {
        saveAuthSuccess(User(id = 1, username = "alice", fullName = "Alice"), "token")
    }
    private val sockets = mutableListOf<Pair<WebSocket, WebSocketListener>>()
    private val openedAt = mutableListOf<Long>()
    private val client = WebSocketClient(sessionManager, webSocketFactory = { request, listener ->
        openedAt += scope.testScheduler.currentTime
        FakeSocket(request).also { sockets += it to listener }
    })

    @After
    fun tearDown() {
        client.disconnect()
        scope.coroutineContext[Job]?.cancel()
    }

    private fun openLatestAndSay(text: String) {
        val (socket, listener) = sockets.last()
        listener.onOpen(socket, Response.Builder().request(socket.request()).protocol(Protocol.HTTP_1_1)
            .code(101).message("").build())
        listener.onMessage(socket, text)
    }

    private fun refuseLatest(code: String) =
        openLatestAndSay("""{"type":"auth_error","code":"$code","message":"Слишком много открытых окон. Закройте лишние."}""")

    /** Lets virtual time pass until the next socket is opened; returns the time it took. */
    private fun timeUntilNextSocket(): Long {
        val before = sockets.size
        val start = scope.testScheduler.currentTime
        while (sockets.size == before) {
            scope.advanceTimeBy(100)
            scope.runCurrent()
            check(scope.testScheduler.currentTime - start < 600_000) { "no reconnect within 10 minutes" }
        }
        return openedAt.last() - start
    }

    @Test
    fun repeatedSessionLimitRefusalsBackOffInsteadOfLoopingEverySecond() {
        client.connect(scope)

        val gaps = (1..3).map {
            refuseLatest("TOO_MANY_SESSIONS")
            timeUntilNextSocket()
        }

        assertTrue("first retry waits well over a second, was $gaps", gaps[0] >= 5_000)
        assertTrue("delays must grow between attempts, were $gaps", gaps[1] > gaps[0] && gaps[2] > gaps[1])
    }

    @Test
    fun noFourthSocketWithinThreeSecondsOfRateLimiting() {
        client.connect(scope)

        repeat(3) {
            refuseLatest("RATE_LIMITED")
            if (it < 2) timeUntilNextSocket()
        }
        scope.advanceTimeBy(3_000)
        scope.runCurrent()

        assertEquals(3, sockets.size)
    }

    @Test
    fun anAcceptedSessionResetsTheBackoff() {
        client.connect(scope)
        refuseLatest("RATE_LIMITED")
        timeUntilNextSocket()
        refuseLatest("RATE_LIMITED")
        val grown = timeUntilNextSocket()

        openLatestAndSay("""{"type":"auth_success","user":{"id":1,"username":"alice","full_name":"Alice"}}""")
        sockets.last().let { (socket, listener) -> listener.onClosed(socket, 1006, "network") }
        val afterReset = timeUntilNextSocket()

        assertTrue("reset delay $afterReset must be shorter than grown delay $grown", afterReset < grown)
    }

    @Test
    fun theRefusalIsReportedOnceNotOnEveryRetry() {
        val events = mutableListOf<WsEvent>()
        scope.launch { client.events.collect { events += it } }
        scope.runCurrent() // subscribe before the first refusal arrives
        client.connect(scope)

        repeat(3) {
            refuseLatest("TOO_MANY_SESSIONS")
            scope.runCurrent()
            timeUntilNextSocket()
        }

        assertEquals(1, events.count { it is WsEvent.AuthError })
        assertEquals(
            ConnectionState.Retrying("TOO_MANY_SESSIONS", "Слишком много открытых окон. Закройте лишние."),
            client.connectionState.value
        )
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
