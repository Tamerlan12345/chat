package com.openmychat.mobile.data.delivery

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.testing.TestSessions
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test

/** Parity minor: the server's `Retry-After` is honoured, but an automatic sync retry waits at most 30 s. */
class HttpDeliveryBackendTest {

    private fun backend(retryAfter: String) = HttpDeliveryBackend(ApiClient(TestSessions.authenticated(), OkHttpClient.Builder().addInterceptor { chain ->
        Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(503).message("x")
            .header("Retry-After", retryAfter).body("""{"error":"busy"}""".toResponseBody()).build()
    }.build()))

    @Test
    fun aShortWaitIsTakenAsSent() = runBlocking {
        assertEquals(SyncOutcome.Failed(503, 7_000), backend("7").sync(null, 200))
    }

    @Test
    fun aLongWaitIsCappedAtThirtySeconds() = runBlocking {
        assertEquals(SyncOutcome.Failed(503, 30_000), backend("3600").sync(null, 200))
    }
}
