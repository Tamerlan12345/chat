package com.openmychat.mobile.core.network

import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.core.session.SessionManager
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class ApiClientLogoutStorageTest {

    @Test
    fun logoutFailsWhenSecureSessionCannotBeCleared() = runBlocking {
        val sessionManager = SessionManager(prefs = null, isDebuggableBuild = false)
        val endpoint = sessionManager.validateServerEndpoint("https://chat.example").getOrThrow()
        sessionManager.useServerEndpointForVerification(endpoint)
        val requests = AtomicInteger(0)
        val apiClient = ApiClient(sessionManager, successfulLogoutClient(requests))

        try {
            apiClient.logout()
            fail("logout must not report success when protected credentials could not be cleared")
        } catch (_: SecureStorageUnavailableException) {
            // Expected: local storage is verified before any remote logout request.
        }
        assertEquals(0, requests.get())
    }

    private fun successfulLogoutClient(requests: AtomicInteger): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            requests.incrementAndGet()
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(204)
                .message("No Content")
                .body("".toResponseBody())
                .build()
        }
        .build()
}
