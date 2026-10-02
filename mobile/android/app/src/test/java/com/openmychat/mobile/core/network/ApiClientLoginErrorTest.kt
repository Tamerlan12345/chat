package com.openmychat.mobile.core.network

import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.LoginRequest
import com.openmychat.mobile.testing.InMemorySharedPreferences
import com.openmychat.mobile.testing.TestSessions
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import javax.net.ssl.SSLHandshakeException

/** What the login screen needs from a failed `POST /api/auth/login` (codes from server/src/api/index.js). */
class ApiClientLoginErrorTest {

    @Test
    fun throttlingCarriesTheRetryAfterSeconds() {
        val error = loginFailure(respond(429, """{"error":"Слишком много попыток","code":"ACCOUNT_THROTTLED"}""", retryAfter = "42"))

        assertEquals(429, error.statusCode)
        assertEquals("ACCOUNT_THROTTLED", error.errorCode)
        assertEquals(42L, error.retryAfterSeconds)
    }

    @Test
    fun busyServerCarriesTheRetryAfterSeconds() {
        val error = loginFailure(respond(503, """{"error":"Сервер занят","code":"LOGIN_BUSY"}""", retryAfter = "3"))

        assertEquals(503, error.statusCode)
        assertEquals("LOGIN_BUSY", error.errorCode)
        assertEquals(3L, error.retryAfterSeconds)
    }

    @Test
    fun missingOrMalformedRetryAfterIsAbsent() {
        assertNull(loginFailure(respond(429, """{"error":"x"}""")).retryAfterSeconds)
        assertNull(loginFailure(respond(429, """{"error":"x"}""", retryAfter = "soon")).retryAfterSeconds)
        assertNull(loginFailure(respond(429, """{"error":"x"}""", retryAfter = "-5")).retryAfterSeconds)
    }

    @Test
    fun wrongCredentialsAreA400() {
        val error = loginFailure(respond(400, """{"error":"Неверный логин или пароль."}"""))

        assertEquals(400, error.statusCode)
    }

    @Test
    fun certificateFailuresAreReportedApartFromBeingOffline() {
        assertEquals("TLS_ERROR", loginFailure(Interceptor { throw SSLHandshakeException("untrusted") }).errorCode)
        val offline = loginFailure(Interceptor { throw IOException("Unable to resolve host") })
        assertEquals(0, offline.statusCode)
        assertEquals("NETWORK_ERROR", offline.errorCode)
    }

    private fun loginFailure(interceptor: Interceptor): ApiException = runBlocking {
        val sessionManager = SessionManager(prefs = InMemorySharedPreferences(), serverEndpoint = TestSessions.CHAT_EXAMPLE)
        val client = ApiClient(sessionManager, OkHttpClient.Builder().addInterceptor(interceptor).build())
        try {
            client.login(LoginRequest("alice", "wrong"))
            fail("login must fail")
            error("unreachable")
        } catch (error: ApiException) {
            error
        }
    }

    private fun respond(code: Int, body: String, retryAfter: String? = null) = Interceptor { chain ->
        Response.Builder()
            .request(chain.request())
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("Error")
            .apply { if (retryAfter != null) header("Retry-After", retryAfter) }
            .body(body.toResponseBody())
            .build()
    }
}
