package com.openmychat.mobile.core.session

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.testing.InMemorySharedPreferences
import com.openmychat.mobile.testing.TestSessions
import com.openmychat.mobile.testing.jwt
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Review fix round 1 (Ruling U, minor 1): a renewed token is stored only while the session it renewed
 * is still the current one. A refresh that lands after a sign-out never signs the person back in, and
 * one that lands after another account signed in never overwrites that account's token.
 */
class SessionTokenReplaceTest {

    private val bob = User(id = 1, username = "bob", fullName = "Bob")
    private val carol = User(id = 2, username = "carol", fullName = "Carol")
    private val session = SessionManager(prefs = InMemorySharedPreferences(), serverEndpoint = TestSessions.CHAT_EXAMPLE).apply {
        saveAuthSuccess(bob, jwt(1, "old"))
    }

    @Test
    fun theRenewedTokenReplacesTheOneItRenewed() {
        assertTrue(session.replaceTokenIfCurrent(jwt(1, "old"), jwt(1, "new")))
        assertEquals(jwt(1, "new"), session.token)
        assertEquals(jwt(1, "new"), session.tokenFlow.value)
    }

    @Test
    fun aRenewalAfterASignOutStoresNothing() {
        session.clearSessionForSignOut()
        assertFalse(session.replaceTokenIfCurrent(jwt(1, "old"), jwt(1, "new")))
        assertNull(session.token)
        assertNull(session.tokenFlow.value)
    }

    @Test
    fun aRenewalOfThePreviousAccountNeverOverwritesTheNextOne() {
        session.saveAuthSuccess(carol, jwt(2))
        assertFalse(session.replaceTokenIfCurrent(jwt(1, "old"), jwt(1, "new")))
        assertEquals(jwt(2), session.token)
    }

    private fun refreshingApi(during: () -> Unit) = ApiClient(session, OkHttpClient.Builder().addInterceptor { chain ->
        during()
        Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
            .body("""{"token":"${jwt(1, "renewed")}"}""".toResponseBody()).build()
    }.build())

    @Test
    fun anExplicitRefreshThatLandsAfterASignOutLeavesNobodySignedIn() = runBlocking {
        refreshingApi { session.clearSessionForSignOut() }.refreshToken()
        assertNull(session.token)
        assertNull(session.currentUser)
    }

    @Test
    fun anExplicitRefreshThatLandsAfterAnotherSignInLeavesThatSessionAlone() = runBlocking {
        refreshingApi { session.saveAuthSuccess(carol, jwt(2)) }.refreshToken()
        assertEquals(jwt(2), session.token)
    }
}
