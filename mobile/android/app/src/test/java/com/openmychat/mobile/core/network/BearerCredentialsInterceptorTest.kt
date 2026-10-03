package com.openmychat.mobile.core.network

import java.util.concurrent.atomic.AtomicReference
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BearerCredentialsInterceptorTest {

    @Test
    fun insecureHttpRequestNeverReceivesBearerCredentials() {
        val authorization = AtomicReference<String?>(null)
        val client = recordingClient(authorization)

        client.newCall(
            Request.Builder()
                .url("http://10.0.2.2:2004/api/health")
                .header("Authorization", "Bearer manually-set-token")
                .build()
        ).execute().close()

        assertNull(authorization.get())
    }

    @Test
    fun secureHttpsRequestReceivesCurrentBearerCredentials() {
        val authorization = AtomicReference<String?>(null)
        val client = recordingClient(authorization, trustedServerUrl = "https://chat.example/api")

        client.newCall(Request.Builder().url("https://chat.example/api/health").build()).execute().close()

        assertEquals("Bearer secure-token", authorization.get())
    }

    @Test
    fun secureRequestWithoutAnEstablishedServerOriginNeverReceivesBearerCredentials() {
        val authorization = AtomicReference<String?>(null)
        val client = recordingClient(authorization, trustedServerUrl = null)

        client.newCall(Request.Builder().url("https://untrusted.example/api/health").build()).execute().close()

        assertNull(authorization.get())
    }

    @Test
    fun secureRequestForAnotherOriginNeverReceivesBearerCredentials() {
        val authorization = AtomicReference<String?>(null)
        val client = recordingClient(authorization, trustedServerUrl = "https://chat.example/api")

        client.newCall(Request.Builder().url("https://attacker.example/api/health").build()).execute().close()

        assertNull(authorization.get())
    }

    private fun recordingClient(
        authorization: AtomicReference<String?>,
        trustedServerUrl: String? = "https://chat.example/api"
    ): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(BearerCredentialsInterceptor(
            tokenProvider = { "secure-token" },
            trustedApiBaseUrlProvider = { trustedServerUrl?.toHttpUrlOrNull() },
            markMustChangePassword = {}
        ))
        .addInterceptor { chain ->
            authorization.set(chain.request().header("Authorization"))
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body("{}".toResponseBody())
                .build()
        }
        .build()
}
