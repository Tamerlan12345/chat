package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.testing.InMemorySharedPreferences
import com.openmychat.mobile.testing.TestSessions
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A knock without a device secret can never pair, yet the server still records it: a pending
 * device row, an admin broadcast and a hit on the per-IP knock-fail budget. So the client only
 * knocks with a secret it stored when it claimed this device.
 */
class AuthRepositoryKnockTest {

    private val bodies = CopyOnWriteArrayList<String>()

    private val client = OkHttpClient.Builder()
        .addInterceptor { chain ->
            val request = chain.request()
            bodies += Buffer().also { request.body?.writeTo(it) }.readUtf8()
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body("""{"status":"pending"}""".toResponseBody())
                .build()
        }
        .build()

    private fun repository(session: SessionManager) = DefaultAuthRepository(ApiClient(session, client), session)

    @Test
    fun withoutAStoredDeviceSecretNothingIsSent() = runBlocking {
        val session = SessionManager(prefs = InMemorySharedPreferences(), serverEndpoint = TestSessions.CHAT_EXAMPLE)

        assertFalse(repository(session).knock())
        assertEquals(emptyList<String>(), bodies)
    }

    @Test
    fun aClaimedDeviceKnocksWithItsStoredSecret() = runBlocking {
        val session = SessionManager(prefs = InMemorySharedPreferences(), serverEndpoint = TestSessions.CHAT_EXAMPLE)
        session.deviceSecret = "stored-secret"

        assertFalse("pending is not paired", repository(session).knock())
        assertEquals(1, bodies.size)
        assertTrue(bodies.single(), bodies.single().contains(""""device_secret":"stored-secret""""))
    }
}
