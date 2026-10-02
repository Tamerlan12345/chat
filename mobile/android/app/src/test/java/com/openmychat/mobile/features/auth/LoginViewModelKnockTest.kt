package com.openmychat.mobile.features.auth

import com.openmychat.mobile.testing.FakeAuthRepository
import com.openmychat.mobile.testing.FakeLoginPreferences
import com.openmychat.mobile.testing.MainDispatcherRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** The device announcement (`/auth/knock`) that used to run on server setup now runs on the login screen. */
class LoginViewModelKnockTest {

    @get:Rule
    val mainDispatcher = MainDispatcherRule()

    @Test
    fun aPairedDeviceIsSignedInWithoutAPassword() {
        val auth = FakeAuthRepository().apply { onKnock = { true } }

        val viewModel = LoginViewModel(auth, FakeLoginPreferences())
        viewModel.onScreenShown()
        viewModel.onScreenShown()

        assertEquals("announced once per screen", 1, auth.knocks)
        assertEquals(LoginUiState.Success, viewModel.uiState.value)
        assertEquals(emptyList<Pair<String, String>>(), auth.loginAttempts)
    }

    @Test
    fun aFailedKnockLeavesTheLoginFormReady() {
        val auth = FakeAuthRepository().apply { onKnock = { error("offline") } }

        val viewModel = LoginViewModel(auth, FakeLoginPreferences())
        viewModel.onScreenShown()

        assertEquals(1, auth.knocks)
        assertEquals(LoginUiState.Idle, viewModel.uiState.value)
    }
}
