package com.openmychat.mobile.core.network

import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.repository.DefaultAuthRepository
import com.openmychat.mobile.testing.InMemorySharedPreferences
import com.openmychat.mobile.testing.TestSessions
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

/**
 * Final review I1: signing out ends the device's password-free sign-in too. The server unbinds the
 * secret only when `/auth/logout` names the device; the app forgets the secret itself, so the login
 * screen's knock cannot sign the same person back in without a password.
 */
class ApiClientLogoutDeviceTest {

    private val prefs = InMemorySharedPreferences()
    private val session = SessionManager(prefs = prefs, serverEndpoint = TestSessions.CHAT_EXAMPLE).apply {
        saveAuthSuccess(User(id = 1, username = "bob", fullName = "Bob"), "token")
        deviceSecret = "paired-secret"
    }
    private val sent = mutableListOf<Pair<String, String>>()
    private val client = OkHttpClient.Builder().addInterceptor { chain ->
        val request = chain.request()
        sent += request.url.encodedPath to Buffer().also { request.body?.writeTo(it) }.readUtf8()
        Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
            .body("""{"success":true,"status":"paired","token":"t","user":{"id":1,"username":"bob","full_name":"Bob"}}""".toResponseBody())
            .build()
    }.build()

    @Test
    fun signingOutNamesThisDeviceSoTheServerUnbindsItsSecret() = runBlocking {
        val deviceId = session.deviceId
        ApiClient(session, client).logout()

        val (path, body) = sent.single()
        assertEquals("/api/auth/logout", path)
        assertEquals(deviceId, Json.parseToJsonElement(body).jsonObject["device_id"]?.jsonPrimitive?.content)
    }

    @Test
    fun signingOutForgetsTheDeviceSecretSoTheLoginScreenNoLongerKnocks() = runBlocking {
        val auth = DefaultAuthRepository(ApiClient(session, client), session)
        auth.logout()
        sent.clear()

        assertNull(session.deviceSecret)
        assertFalse("no password-free sign-in after a sign-out", auth.knock())
        assertEquals("nothing is even sent", emptyList<Pair<String, String>>(), sent)
        assertNull(session.token)
    }

    @Test
    fun aSecretThatCannotBeForgottenFailsTheSignOut() = runBlocking {
        prefs.failCommits = true
        try {
            ApiClient(session, client).logout()
            fail("a sign-out that leaves the device secret behind must not report success")
        } catch (_: com.openmychat.mobile.core.session.SecureStorageUnavailableException) {
        }
        assertEquals(emptyList<Pair<String, String>>(), sent)
    }
}
