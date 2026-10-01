package com.openmychat.mobile.features.connect

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.session.SessionManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerConnectViewModelStorageTest {

    @Test
    fun onboardingShowsRecoverableErrorAndDoesNotNavigateWhenEndpointCannotBeStored() = runBlocking {
        Dispatchers.setMain(Dispatchers.Unconfined)
        try {
            val sessionManager = SessionManager(prefs = null, isDebuggableBuild = false)
            val viewModel = ServerConnectViewModel(ApiClient(sessionManager, connectedServerClient()), sessionManager)
            var navigationRequested = false

            viewModel.updateServerUrl("https://chat.example")
            viewModel.checkConnection { navigationRequested = true }

            val state = withTimeout(2_000) {
                viewModel.uiState.first { it is ServerConnectUiState.Error }
            }
            assertTrue(state is ServerConnectUiState.Error)
            assertFalse(navigationRequested)
            assertTrue(sessionManager.serverUrl.isBlank())
        } finally {
            Dispatchers.resetMain()
        }
    }

    private fun connectedServerClient(): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            val body = when (chain.request().url.encodedPath) {
                "/api/health" -> """{"status":"ok"}"""
                "/api/auth/knock" -> """{"status":"login_required"}"""
                else -> error("Unexpected endpoint: ${chain.request().url}")
            }
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(body.toResponseBody())
                .build()
        }
        .build()
}
