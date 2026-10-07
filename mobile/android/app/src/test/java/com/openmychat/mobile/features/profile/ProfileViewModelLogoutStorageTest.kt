package com.openmychat.mobile.features.profile

import android.content.SharedPreferences
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.core.session.SessionStorageState
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.repository.DefaultAuthRepository
import com.openmychat.mobile.data.repository.DefaultProfileRepository
import com.openmychat.mobile.data.repository.DefaultRealtimeRepository
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
import com.openmychat.mobile.testing.TestSessions

class ProfileViewModelLogoutStorageTest {

    /**
     * Review fix round 1 (Ruling U, minor 3): when the secure store refuses the wipe, the session is
     * already gone from memory and marked unusable on disk — this device IS signed out. The screen must
     * not claim «выход отменён»: it goes to the login screen, which says the storage is unavailable.
     */
    @Test
    fun aSignOutWhoseDiskWipeFailsIsStillASignOutNeverReportedAsCancelled() = runBlocking {
        Dispatchers.setMain(Dispatchers.Unconfined)
        try {
            val prefs = com.openmychat.mobile.testing.InMemorySharedPreferences()
            val sessionManager = SessionManager(prefs = prefs, serverEndpoint = TestSessions.CHAT_EXAMPLE).apply {
                saveAuthSuccess(User(id = 1, username = "alice", fullName = "Alice"), "token")
            }
            val viewModel = profileViewModel(sessionManager)
            prefs.failCommits = true
            var navigationRequested = false

            viewModel.logout { navigationRequested = true }
            withTimeout(2_000) { while (!navigationRequested) kotlinx.coroutines.delay(10) }

            assertTrue("signed out on this device", navigationRequested)
            assertEquals(null, sessionManager.token)
            assertEquals(SessionStorageState.UNAVAILABLE, sessionManager.storageState.value)
            assertEquals("no «выход отменён» for a sign-out that happened", null, viewModel.logoutError.value)
        } finally {
            Dispatchers.resetMain()
        }
    }

    private fun profileViewModel(sessionManager: SessionManager): ProfileViewModel {
        // No real network: the profile refresh of init fails at once instead of resolving a host and
        // resuming on Dispatchers.Main after this test has reset it (an uncaught error in a later test).
        val offline = okhttp3.OkHttpClient.Builder()
            .addInterceptor { throw java.io.IOException("offline in this test") }
            .build()
        val apiClient = ApiClient(sessionManager, offline)
        val realtime = DefaultRealtimeRepository(WebSocketClient(sessionManager))
        return ProfileViewModel(
            profileRepository = DefaultProfileRepository(apiClient, sessionManager),
            authRepository = DefaultAuthRepository(apiClient, sessionManager),
            realtimeRepository = realtime,
            presenceController = com.openmychat.mobile.data.realtime.PresenceController(
                realtime,
                kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined)
            )
        )
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
