package com.openmychat.mobile.features.auth

import android.content.SharedPreferences
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.core.session.SessionStorageState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    @Test
    fun loginNeverEmitsSuccessWhenDeviceSecretWriteFailsAfterSessionWasStored() = runBlocking {
        Dispatchers.setMain(Dispatchers.Unconfined)
        try {
            val storage = FailingAfterFirstCommitSharedPreferences()
            val sessionManager = SessionManager(
                prefs = storage,
                isDebuggableBuild = false
            ).apply {
                useServerEndpointForVerification(
                    validateServerEndpoint("https://chat.example").getOrThrow()
                )
            }
            val requestPaths = mutableListOf<String>()
            val viewModel = LoginViewModel(
                ApiClient(sessionManager, claimedDeviceLoginClient(requestPaths)),
                sessionManager
            )
            val emittedStates = mutableListOf<LoginUiState>()
            val observer = launch(Dispatchers.Unconfined) {
                viewModel.uiState.collect { emittedStates += it }
            }

            viewModel.login(username = "alice", password = "password")

            val terminalState = withTimeout(2_000) {
                viewModel.uiState.first { it is LoginUiState.Error || it is LoginUiState.Success }
            }
            observer.cancel()

            assertTrue(
                "expected recoverable storage error, got $terminalState after ${storage.commitCount} writes and $requestPaths",
                terminalState is LoginUiState.Error
            )
            assertEquals(listOf("/api/auth/login", "/api/auth/device/claim"), requestPaths)
            assertEquals(2, storage.commitCount)
            assertFalse(emittedStates.any { it is LoginUiState.Success })
            assertEquals(SessionStorageState.UNAVAILABLE, sessionManager.storageState.value)
            assertNull(sessionManager.token)
            assertNull(sessionManager.currentUser)
            assertNull(sessionManager.deviceSecret)
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

    private fun claimedDeviceLoginClient(requestPaths: MutableList<String>): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            val path = chain.request().url.encodedPath
            requestPaths += path
            val body = when (path) {
                "/api/auth/login" ->
                    """{"user":{"id":1,"username":"alice","full_name":"Alice"},"token":"sensitive-token"}"""
                "/api/auth/device/claim" -> """{"claimed":true}"""
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

    private class FailingAfterFirstCommitSharedPreferences : SharedPreferences {
        private val values = mutableMapOf<String, Any?>("device_id" to "existing-device-id")
        var commitCount = 0
            private set

        override fun getAll(): MutableMap<String, *> = values
        override fun getString(key: String, defValue: String?): String? = values[key] as? String ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = defValues
        override fun getInt(key: String, defValue: Int): Int = values[key] as? Int ?: defValue
        override fun getLong(key: String, defValue: Long): Long = values[key] as? Long ?: defValue
        override fun getFloat(key: String, defValue: Float): Float = values[key] as? Float ?: defValue
        override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
        override fun contains(key: String): Boolean = values.containsKey(key)
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            private val pending = mutableMapOf<String, Any?>()

            override fun putString(key: String, value: String?): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = apply { pending[key] = values }
            override fun putInt(key: String, value: Int): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putLong(key: String, value: Long): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = apply { pending[key] = value }
            override fun remove(key: String): SharedPreferences.Editor = apply { pending[key] = null }
            override fun clear(): SharedPreferences.Editor = apply { pending.clear(); values.keys.forEach { pending[it] = null } }
            override fun commit(): Boolean {
                commitCount += 1
                if (commitCount > 1) return false
                pending.forEach { (key, value) ->
                    if (value == null) values.remove(key) else values[key] = value
                }
                return true
            }
            override fun apply() = Unit
        }
    }
}
