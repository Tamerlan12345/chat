package com.openmychat.mobile.features.profile

import android.content.SharedPreferences
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.core.session.SessionStorageState
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
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

    @Test
    fun setStatusShowsRecoverableErrorWhenUserWriteCannotBePersisted() = runBlocking {
        Dispatchers.setMain(Dispatchers.Unconfined)
        try {
            val storage = FailingAfterFirstCommitSharedPreferences()
            val sessionManager = SessionManager(prefs = storage, isDebuggableBuild = false)
            sessionManager.saveAuthSuccess(
                User(id = 1, username = "alice", fullName = "Alice"),
                "trusted-token"
            )
            val viewModel = ProfileViewModel(
                apiClient = ApiClient(sessionManager),
                webSocketClient = WebSocketClient(sessionManager),
                sessionManager = sessionManager
            )

            viewModel.setStatus(UserStatus.AWAY)

            val error = requireNotNull(withTimeout(2_000) {
                viewModel.storageError.first { !it.isNullOrBlank() }
            })
            assertTrue(error.contains("storage", ignoreCase = true))
            assertEquals(SessionStorageState.UNAVAILABLE, sessionManager.storageState.value)
        } finally {
            Dispatchers.resetMain()
        }
    }

    private class FailingAfterFirstCommitSharedPreferences : SharedPreferences {
        private val values = mutableMapOf<String, Any?>()
        private var commits = 0

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
                commits += 1
                if (commits > 1) return false
                pending.forEach { (key, value) -> if (value == null) values.remove(key) else values[key] = value }
                return true
            }
            override fun apply() = Unit
        }
    }
}
