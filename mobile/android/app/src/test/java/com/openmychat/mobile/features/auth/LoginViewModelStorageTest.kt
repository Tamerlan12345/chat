package com.openmychat.mobile.features.auth

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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LoginViewModelStorageTest {

    @Test
    fun loginShowsRecoverableErrorInsteadOfSuccessWhenSessionCannotBeStored() = runBlocking {
        Dispatchers.setMain(Dispatchers.Unconfined)
        try {
            val sessionManager = SessionManager(prefs = null, isDebuggableBuild = false).apply {
                serverUrl = "https://chat.example"
            }
            val viewModel = LoginViewModel(ApiClient(sessionManager, successfulLoginClient()), sessionManager)

            viewModel.login(username = "alice", password = "password")

            val state = withTimeout(2_000) {
                viewModel.uiState.first { it is LoginUiState.Error }
            }
            assertTrue(state is LoginUiState.Error)
            assertNull(sessionManager.token)
            assertNull(sessionManager.currentUser)
        } finally {
            Dispatchers.resetMain()
        }
    }

    private fun successfulLoginClient(): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(
                    """{"user":{"id":1,"username":"alice","full_name":"Alice"},"token":"sensitive-token"}"""
                        .toResponseBody()
                )
                .build()
        }
        .build()
}
