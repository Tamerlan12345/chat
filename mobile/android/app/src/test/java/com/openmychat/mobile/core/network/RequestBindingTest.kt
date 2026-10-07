package com.openmychat.mobile.core.network

import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.testing.InMemorySharedPreferences
import com.openmychat.mobile.testing.TestSessions
import com.openmychat.mobile.testing.jwt
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

/**
 * Final review I4 (parked item 1): an HTTP request belongs to the account it was made for. It is
 * never sent, nor replayed, with another account's token, and a late 401 of another account's
 * request never ends the session that is signed in now.
 */
class RequestBindingTest {

    private val bob = User(id = 1, username = "bob", fullName = "Bob")
    private val carol = User(id = 2, username = "carol", fullName = "Carol")

    private fun session(user: User = bob, token: String = jwt(user.id)) =
        SessionManager(prefs = InMemorySharedPreferences(), serverEndpoint = TestSessions.CHAT_EXAMPLE).apply {
            saveAuthSuccess(user, token)
        }

    private fun respond(request: Request, code: Int, body: String = "{}") = Response.Builder()
        .request(request).protocol(Protocol.HTTP_1_1).code(code).message("x").body(body.toResponseBody()).build()

    // ── the claims of a token ─────────────────────────────────────────────────────────────────

    @Test
    fun theAccountOfATokenIsItsUserIdClaim() {
        assertEquals(7L, JwtClaims.userId(jwt(7)))
        assertNull("not a JWT", JwtClaims.userId("opaque-token"))
        assertNull(JwtClaims.userId(null))
        assertTrue(JwtClaims.sameAccount(jwt(7, "a"), jwt(7, "b")))
        assertTrue("unknown accounts are never the same", !JwtClaims.sameAccount("a", "a2"))
        assertTrue(!JwtClaims.sameAccount(jwt(7), jwt(8)))
    }

    // ── 401 ends only the session it refused ───────────────────────────────────────────────────

    @Test
    fun aLate401OfThePreviousAccountsRequestLeavesTheNewSessionAlone() = runBlocking {
        val session = session(bob)
        val api = ApiClient(session, OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            // Carol signs in while Bob's request is on its way; the server refuses Bob's token.
            session.saveAuthSuccess(carol, jwt(carol.id))
            respond(chain.request(), 401, """{"error":"Необходима авторизация"}""")
        }).build())

        try {
            api.getDirectConversations()
            fail("the refusal still reaches the caller")
        } catch (_: UnauthorizedException) {
        }

        assertEquals("Carol stays signed in", jwt(carol.id), session.token)
        assertEquals(carol.id, session.currentUser?.id)
    }

    @Test
    fun aLate401OfARawRequestOfThePreviousAccountLeavesTheNewSessionAlone() = runBlocking {
        val session = session(bob)
        val api = ApiClient(session, OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            session.saveAuthSuccess(carol, jwt(carol.id))
            respond(chain.request(), 401)
        }).build())

        val response = withContext(RequestOwner(bob.id)) { api.raw("GET", "/api/sync?limit=200") }

        assertEquals(401, response.status)
        assertEquals(jwt(carol.id), session.token)
    }

    @Test
    fun a401OfTheCurrentSessionsRawRequestStillEndsIt() = runBlocking {
        val session = session(bob)
        val api = ApiClient(session, OkHttpClient.Builder().addInterceptor(Interceptor { chain -> respond(chain.request(), 401) }).build())

        assertEquals(401, withContext(RequestOwner(bob.id)) { api.raw("GET", "/api/sync?limit=200") }.status)
        assertNull("a definitive refusal of the current token ends the session", session.token)
    }

    // ── an account's request never goes under another account ─────────────────────────────────

    @Test
    fun aRequestMadeForAnotherAccountIsNeverSent() = runBlocking {
        val session = session(carol)
        var sent = 0
        val api = ApiClient(session, OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            sent++
            respond(chain.request(), 201, """{"id":5}""")
        }).build())

        val body = buildJsonObject { put("text", JsonPrimitive("от Боба")) }
        val response = withContext(RequestOwner(bob.id)) { api.raw("POST", "/api/messages/direct/7", body) }

        assertEquals("not sent: no answer", 0, response.status)
        assertEquals(0, sent)
    }

    @Test
    fun aRequestOfTheSignedInAccountCarriesItsBinding() = runBlocking {
        val session = session(bob)
        var bound: BoundCredentials? = null
        val api = ApiClient(session, OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            bound = chain.request().tag(BoundCredentials::class.java)
            respond(chain.request(), 200, "{}")
        }).build())

        assertEquals(200, withContext(RequestOwner(bob.id)) { api.raw("GET", "/api/sync?limit=200") }.status)
        assertEquals(jwt(bob.id), bound?.token)
        assertEquals(bob.id, bound?.owner)
    }

    // ── the interceptor sends a bound request only as its account ─────────────────────────────

    private fun recording(current: () -> String?, seen: MutableList<String?>) = OkHttpClient.Builder()
        .addInterceptor(BearerCredentialsInterceptor(
            tokenProvider = current,
            trustedApiBaseUrlProvider = { "https://chat.example/api".toHttpUrlOrNull() },
            markMustChangePassword = {}
        ))
        .addInterceptor { chain ->
            seen += chain.request().header("Authorization")
            respond(chain.request(), 200)
        }
        .build()

    private fun bound(token: String?, owner: Long? = null) = Request.Builder()
        .url("https://chat.example/api/messages/direct/7")
        .tag(BoundCredentials::class.java, BoundCredentials(token, owner))
        .build()

    @Test
    fun aRequestBoundToTheOldAccountIsNotSentWithTheNewAccountsToken() {
        val seen = mutableListOf<String?>()
        try {
            recording({ jwt(carol.id) }, seen).newCall(bound(jwt(bob.id), bob.id)).execute().close()
            fail("another account's request must not go out")
        } catch (e: IOException) {
            assertTrue(e is AccountChangedException)
        }
        assertEquals(emptyList<String?>(), seen)
    }

    @Test
    fun aRequestBoundToARefreshedTokenOfTheSameAccountGoesWithTheCurrentOne() {
        val seen = mutableListOf<String?>()
        recording({ jwt(bob.id, "refreshed") }, seen).newCall(bound(jwt(bob.id), bob.id)).execute().close()
        assertEquals(listOf<String?>("Bearer ${jwt(bob.id, "refreshed")}"), seen)
    }

    @Test
    fun aRequestMadeSignedOutNeverPicksUpALaterSession() {
        val seen = mutableListOf<String?>()
        recording({ jwt(carol.id) }, seen).newCall(bound(null)).execute().close()
        assertEquals(listOf<String?>(null), seen)
    }

    @Test
    fun aBoundRequestOfAnAccountThatSignedOutIsNotSent() {
        val seen = mutableListOf<String?>()
        try {
            recording({ null }, seen).newCall(bound(jwt(bob.id), bob.id)).execute().close()
            fail("a signed-out account's request must not go out")
        } catch (_: AccountChangedException) {
        }
        assertEquals(emptyList<String?>(), seen)
    }
}
