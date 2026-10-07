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
    // ── Final review I4: a 401 is replayed only as the account the request was made for ──────────

    private fun refusal(sentWith: String?): Response = Request.Builder().url("https://chat.example.com/api/messages/direct/7")
        .apply { if (sentWith != null) header("Authorization", "Bearer $sentWith") }
        .build().let {
            Response.Builder().request(it).protocol(Protocol.HTTP_1_1).code(401).message("Unauthorized").body("{}".toResponseBody()).build()
        }

    @Test
    fun aRequestSentWithoutATokenIsNeverReplayedWithTheCurrentSession() {
        token = com.openmychat.mobile.testing.jwt(2)
        var refreshed = 0
        val retry = authenticator { refreshed++; RefreshOutcome.Renewed("x") }.authenticate(null, refusal(null))
        assertEquals(null, retry)
        assertEquals("no refresh on behalf of a request that had no token", 0, refreshed)
    }

    @Test
    fun theOldAccountsRequestIsNeverReplayedWithTheNewAccountsToken() {
        token = com.openmychat.mobile.testing.jwt(2) // Carol signed in after Bob's request left
        var refreshed = 0
        val retry = authenticator { refreshed++; RefreshOutcome.Renewed("x") }
            .authenticate(null, refusal(com.openmychat.mobile.testing.jwt(1)))
        assertEquals(null, retry)
        assertEquals(0, refreshed)
        assertEquals(com.openmychat.mobile.testing.jwt(2), token)
    }

    @Test
    fun aRequestOfTheSameAccountIsReplayedWithItsRefreshedToken() {
        val fresh = com.openmychat.mobile.testing.jwt(1, "fresh")
        token = fresh // another request already refreshed Bob's session
        val retry = authenticator { RefreshOutcome.Renewed("unused") }.authenticate(null, refusal(com.openmychat.mobile.testing.jwt(1, "old")))
        assertEquals("Bearer $fresh", retry!!.header("Authorization"))
    }
    /** Ruling U minor 1: the session was replaced while its refresh ran — the old request is not replayed. */
    @Test
    fun aRefreshWhoseSessionWasReplacedMeanwhileReplaysNothing() {
        val retry = authenticator { RefreshOutcome.Superseded }.authenticate(null, unauthorized)
        assertEquals(null, retry)
        assertEquals("old", token)
    }
}
