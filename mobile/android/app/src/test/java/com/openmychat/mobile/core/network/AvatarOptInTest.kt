package com.openmychat.mobile.core.network

import com.openmychat.mobile.ui.components.AvatarPalette
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.concurrent.atomic.AtomicReference

/**
 * Аватары ссылкой (сервер, задача 20): клиент явно просит адреса вместо data URL — заголовком в
 * HTTP и параметром при подключении WebSocket, а картинку берёт нужного размера.
 */
class AvatarOptInTest {

    private fun client(seen: AtomicReference<String?>) = OkHttpClient.Builder()
        .addInterceptor(BearerCredentialsInterceptor(
            tokenProvider = { "token" },
            trustedApiBaseUrlProvider = { "https://chat.example/api".toHttpUrlOrNull() },
            markMustChangePassword = {}
        ))
        .addInterceptor { chain ->
            seen.set(chain.request().header(AvatarOptIn.HEADER))
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body("{}".toResponseBody())
                .build()
        }
        .build()

    @Test
    fun requestsToTheServerAskForAvatarUrls() {
        val seen = AtomicReference<String?>(null)
        client(seen).newCall(Request.Builder().url("https://chat.example/api/users").build()).execute().close()
        assertEquals("url", seen.get())
    }

    @Test
    fun otherHostsDoNotGetTheHeader() {
        val seen = AtomicReference<String?>("unset")
        client(seen).newCall(Request.Builder().url("https://cdn.example/a.png").build()).execute().close()
        assertNull(seen.get())
    }

    @Test
    fun theWebSocketConnectsWithAvatarUrls() {
        assertEquals("wss://chat.example/ws?avatars=url", AvatarOptIn.webSocketUrl("wss://chat.example/ws"))
    }

    @Test
    fun serverAvatarsAreFetchedAtTheSizeShown() {
        val server = "https://chat.example"
        assertEquals(
            "https://chat.example/api/users/5/avatar?v=ab12&size=s",
            AvatarPalette.resolveUrl("/api/users/5/avatar?v=ab12", server, AvatarOptIn.Size.SMALL)
        )
        assertEquals(
            "https://chat.example/api/users/5/avatar?v=ab12&size=m",
            AvatarPalette.resolveUrl("/api/users/5/avatar?v=ab12", server, AvatarOptIn.Size.MEDIUM)
        )
        // Чужие адреса не трогаем.
        assertEquals(
            "https://cdn.example/p.jpg",
            AvatarPalette.resolveUrl("https://cdn.example/p.jpg", server, AvatarOptIn.Size.SMALL)
        )
        // data URL по-прежнему не загружается (инициалы).
        assertNull(AvatarPalette.resolveUrl("data:image/png;base64,AAAA", server, AvatarOptIn.Size.SMALL))
    }

    @Test
    fun sizeFollowsTheShownDiameter() {
        assertEquals(AvatarOptIn.Size.SMALL, AvatarOptIn.sizeFor(44f))
        assertEquals(AvatarOptIn.Size.MEDIUM, AvatarOptIn.sizeFor(96f))
    }
}
