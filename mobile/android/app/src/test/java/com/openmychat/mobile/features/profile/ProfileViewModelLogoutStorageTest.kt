package com.openmychat.mobile.features.profile

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.session.SessionManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProfileViewModelLogoutStorageTest {

    @Test
    fun logoutKeepsUserOnProfileWhenSecureSessionCannotBeCleared() = runBlocking {
        Dispatchers.setMain(Dispatchers.Unconfined)
        try {
            val sessionManager = SessionManager(prefs = null, isDebuggableBuild = false)
            val viewModel = ProfileViewModel(
                apiClient = ApiClient(sessionManager),
                webSocketClient = WebSocketClient(sessionManager),
                sessionManager = sessionManager
            )
            var navigationRequested = false

            viewModel.logout { navigationRequested = true }

            val error = requireNotNull(withTimeout(2_000) {
                viewModel.logoutError.first { it != null }
            })
            assertTrue(error.contains("storage", ignoreCase = true))
            assertFalse(navigationRequested)
        } finally {
            Dispatchers.resetMain()
        }
    }
}
