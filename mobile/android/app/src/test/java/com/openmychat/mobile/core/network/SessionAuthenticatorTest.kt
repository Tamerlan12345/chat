package com.openmychat.mobile.core.network

import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

/**
 * Review fix 1a: only a definitive refusal of the refresh ends the session. No network, a timeout or
 * a server error while refreshing must not turn the request's 401 into a sign-out (which used to wipe
 * the outbox).
 */
class SessionAuthenticatorTest {

    private var token: String? = "old"

    private fun authenticator(refresh: (String) -> RefreshOutcome) =
        SessionAuthenticator(RefreshCoordinator(), { token }, { token = it }, { true }, refresh)

    /** The server's 401 to a request sent with the old token. */
    private val unauthorized: Response = Request.Builder().url("https://chat.example.com/api/sync").header("Authorization", "Bearer old").build().let {
        Response.Builder().request(it).protocol(Protocol.HTTP_1_1).code(401).message("Unauthorized").body("{}".toResponseBody()).build()
    }

    @Test
    fun aRenewedTokenRepeatsTheRequest() {
        val retry = authenticator { RefreshOutcome.Renewed("new") }.authenticate(null, unauthorized)
        assertEquals("Bearer new", retry!!.header("Authorization"))
        assertEquals("new", token)
    }

    @Test
    fun aDefinitiveRefusalLetsThe401Through() {
        val retry = authenticator { RefreshOutcome.Rejected }.authenticate(null, unauthorized)
        assertEquals("the caller's session rules end the session on this 401", null, retry)
    }

    @Test
    fun anUnreachableRefreshIsANetworkErrorNotA401() {
        try {
            authenticator { RefreshOutcome.Unreachable }.authenticate(null, unauthorized)
            fail("an unreachable refresh must not surface the 401")
        } catch (e: IOException) {
            assertTrue(e is RefreshUnreachableException)
        }
        assertEquals("the token stays", "old", token)
    }

    @Test
    fun onlyA401Or403FromTheRefreshIsDefinitive() {
        assertEquals(RefreshOutcome.Renewed("t"), RefreshFailurePolicy.classify(200, "t"))
        assertEquals(RefreshOutcome.Rejected, RefreshFailurePolicy.classify(401, null))
        assertEquals(RefreshOutcome.Rejected, RefreshFailurePolicy.classify(403, null))
        assertEquals("server error", RefreshOutcome.Unreachable, RefreshFailurePolicy.classify(503, null))
        assertEquals("rate limited", RefreshOutcome.Unreachable, RefreshFailurePolicy.classify(429, null))
        assertEquals("no answer (network)", RefreshOutcome.Unreachable, RefreshFailurePolicy.classify(null, null))
        assertEquals("unreadable success", RefreshOutcome.Unreachable, RefreshFailurePolicy.classify(200, null))
    }
}
