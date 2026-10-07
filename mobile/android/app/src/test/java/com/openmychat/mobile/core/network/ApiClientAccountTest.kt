package com.openmychat.mobile.core.network

import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.data.model.RegisterRequestBody
import com.openmychat.mobile.data.model.RegistrationOutcome
import com.openmychat.mobile.data.model.ReportBody
import com.openmychat.mobile.data.model.ReportTargetType
import com.openmychat.mobile.testing.InMemorySharedPreferences
import com.openmychat.mobile.testing.TestSessions
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Requests and answers of mobile/contracts/registration.md as the Android client sends and reads them. */
class ApiClientAccountTest {

    private val requests = mutableListOf<Request>()
    private var status = 200
    private var body = "{}"

    private val interceptor = Interceptor { chain ->
        requests += chain.request()
        Response.Builder()
            .request(chain.request())
            .protocol(Protocol.HTTP_1_1)
            .code(status)
            .message("x")
            .body(body.toResponseBody())
            .build()
    }

    private fun client(session: SessionManager = signedOut()) =
        ApiClient(session, OkHttpClient.Builder().addInterceptor(interceptor).build())

    private fun signedOut() = SessionManager(prefs = InMemorySharedPreferences(), serverEndpoint = TestSessions.CHAT_EXAMPLE)

    private fun Request.json(): JsonObject = Json.parseToJsonElement(Buffer().also { body!!.writeTo(it) }.readUtf8()).jsonObject

    @Test
    fun requestingACodeSendsTheFormAndReadsTheChallenge() = runBlocking {
        status = 202
        body = """{"status":"code_sent","registrationId":"r-1","expiresInSec":600}"""

        val challenge = client().requestRegistration(
            RegisterRequestBody(email = "ivan@company.example", username = "ivanov", displayName = "Иван Иванов", password = "Secret-12")
        )

        assertEquals("r-1", challenge.registrationId)
        assertEquals(600, challenge.expiresInSec)
        val sent = requests.single()
        assertEquals("POST", sent.method)
        assertEquals("/api/auth/register/request", sent.url.encodedPath)
        val json = sent.json()
        assertEquals("ivan@company.example", json["email"]!!.jsonPrimitive.content)
        assertEquals("ivanov", json["username"]!!.jsonPrimitive.content)
        assertEquals("Иван Иванов", json["displayName"]!!.jsonPrimitive.content)
        assertEquals("Secret-12", json["password"]!!.jsonPrimitive.content)
    }

    @Test
    fun aConfirmedCodeOnTheAllowListSignsIn() = runBlocking {
        status = 200
        body = """{"user":{"id":42,"username":"ivanov","full_name":"Иван Иванов"},"token":"tok-42"}"""
        val session = signedOut()

        val outcome = client(session).verifyRegistration("r-1", "123456")

        assertEquals(42L, (outcome as RegistrationOutcome.SignedIn).user.id)
        assertEquals("tok-42", session.token)
        assertEquals(42L, session.currentUser?.id)
        val sent = requests.single()
        assertEquals("/api/auth/register/verify", sent.url.encodedPath)
        assertEquals("r-1", sent.json()["registrationId"]!!.jsonPrimitive.content)
        assertEquals("123456", sent.json()["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun aConfirmedCodeOffTheAllowListWaitsForTheAdministratorWithoutASession() = runBlocking {
        status = 202
        body = """{"status":"pending"}"""
        val session = signedOut()

        assertEquals(RegistrationOutcome.Pending, client(session).verifyRegistration("r-1", "123456"))
        assertNull(session.token)
    }

    @Test
    fun aWrongCodeCarriesTheAttemptsLeft() = runBlocking {
        status = 400
        body = """{"error":"Неверный код","code":"CODE_INVALID","attemptsLeft":3}"""

        val error = failure { client().verifyRegistration("r-1", "000000") }

        assertEquals(400, error.statusCode)
        assertEquals("CODE_INVALID", error.errorCode)
        assertEquals(3, error.attemptsLeft)
    }

    @Test
    fun deletingTheAccountSendsThePasswordInTheBody() = runBlocking {
        body = """{"success":true}"""

        client(TestSessions.authenticated()).deleteAccount("Secret-12")

        val sent = requests.single()
        assertEquals("DELETE", sent.method)
        assertEquals("/api/users/me", sent.url.encodedPath)
        assertEquals("Secret-12", sent.json()["password"]!!.jsonPrimitive.content)
    }

    @Test
    fun reportsBlocksAndTheBlockList() = runBlocking {
        val api = client(TestSessions.authenticated())

        status = 201
        body = """{"id":5,"status":"open"}"""
        api.report(ReportBody(targetType = ReportTargetType.MESSAGE, targetId = 77, reason = "spam", details = null))
        api.blockUser(7)
        status = 200
        body = """{"success":true}"""
        api.unblockUser(7)
        body = """{"blocks":[{"userId":7,"displayName":"Боб","createdAt":"2026-10-05T10:00:00Z"},{"user_id":8,"full_name":"Ева"},{"id":9}]}"""
        val blocked = api.blockedUsers()

        assertEquals(listOf("POST /api/reports", "POST /api/blocks", "DELETE /api/blocks/7", "GET /api/blocks"), requests.map { "${it.method} ${it.url.encodedPath}" })
        val report = requests[0].json()
        assertEquals("message", report["targetType"]!!.jsonPrimitive.content)
        assertEquals("77", report["targetId"]!!.jsonPrimitive.content)
        assertEquals("spam", report["reason"]!!.jsonPrimitive.content)
        assertTrue("no details are sent as absent or null", report["details"] == null || report["details"] == JsonNull)
        assertEquals("7", requests[1].json()["userId"]!!.jsonPrimitive.content)
        assertEquals(listOf(BlockedUser(7, "Боб"), BlockedUser(8, "Ева"), BlockedUser(9, null)), blocked)
    }

    private suspend fun failure(block: suspend () -> Unit): ApiException = try {
        block()
        fail("the request must fail")
        error("unreachable")
    } catch (error: ApiException) {
        error
    }
}
