package com.openmychat.mobile.core.session

import android.content.SharedPreferences
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.repository.DefaultAuthRepository
import com.openmychat.mobile.features.auth.LoginUiState
import com.openmychat.mobile.features.auth.LoginViewModel
import com.openmychat.mobile.ui.navigation.AuthenticatedRouteState
import com.openmychat.mobile.ui.navigation.SessionRouteGuard
import com.openmychat.mobile.ui.navigation.NavKey
import com.openmychat.mobile.core.network.ValidatedEndpoint
import com.openmychat.mobile.testing.TestSessions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SessionManagerPersistentInvalidationTest {

    @Test
    fun failedFirstClearDuringCredentialRotationStaysUnauthenticatedAfterRecreation() {
        val securePrefs = CommitControlledSharedPreferences()
        val invalidation = MemorySessionInvalidation()
        val seeded = sessionManager(securePrefs, invalidation)
        seeded.saveAuthSuccess(alice(), "old-token")
        securePrefs.failNextCommit = true

        assertStorageFailure { seeded.replaceAuthenticatedSession(alice(), "new-token", false) }

        assertRestartIsUnauthenticated(securePrefs, invalidation)
    }

    @Test
    fun failedFirstClearDuringLogoutStaysUnauthenticatedAfterRecreation() {
        val securePrefs = CommitControlledSharedPreferences()
        val invalidation = MemorySessionInvalidation()
        val seeded = sessionManager(securePrefs, invalidation)
        seeded.saveAuthSuccess(alice(), "token")
        securePrefs.failNextCommit = true

        assertFalse(seeded.clearSession())

        assertRestartIsUnauthenticated(securePrefs, invalidation)
    }

    @Test
    fun failedMustChangePasswordSecondaryWriteStaysUnauthenticatedAfterRecreation() {
        val securePrefs = CommitControlledSharedPreferences()
        val invalidation = MemorySessionInvalidation()
        val seeded = sessionManager(securePrefs, invalidation)
        seeded.saveAuthSuccess(alice(), "token")
        securePrefs.failCommitNumber = securePrefs.commits + 2

        assertStorageFailure {
            seeded.currentUser = alice().copy(mustChangePassword = true)
        }

        assertRestartIsUnauthenticated(securePrefs, invalidation)
    }

    @Test
    fun bothDurableInvalidationBarriersFailThenEncryptionKeyIsErased() {
        val securePrefs = CommitControlledSharedPreferences()
        val keyEraser = RecordingKeyEraser { securePrefs.unreadable = true }
        val invalidation = FailClosedSessionInvalidationStore(
            marker = FailingSessionInvalidationMarker(),
            keyEraser = keyEraser,
            sentinel = FailingSessionInvalidationSentinel()
        )
        val seeded = sessionManager(securePrefs, invalidation)
        seeded.saveAuthSuccess(alice(), "token")
        securePrefs.failNextCommit = true

        assertFalse(seeded.clearSession())
        val restarted = sessionManager(securePrefs, invalidation)

        assertTrue(keyEraser.erased)
        assertEquals(SessionStorageState.UNAVAILABLE, restarted.storageState.value)
        assertNull(restarted.token)
        assertNull(restarted.currentUser)
    }

    @Test
    fun durableInvalidationBarrierRetainsEncryptionKeySoRecoveredSessionSurvivesRecreation() {
        val securePrefs = CommitControlledSharedPreferences()
        val marker = MemorySessionInvalidationMarker(initiallyInvalidated = false)
        val sentinel = MemorySessionInvalidationSentinel(initiallyInvalidated = false)
        val keyEraser = RecordingKeyEraser { securePrefs.unreadable = true }
        val invalidation = FailClosedSessionInvalidationStore(
            marker = marker,
            keyEraser = keyEraser,
            sentinel = sentinel
        )
        val seeded = sessionManager(securePrefs, invalidation)
        seeded.saveAuthSuccess(alice(), "stale-token")
        securePrefs.failNextCommit = true

        assertFalse(seeded.clearSession())
        assertTrue(marker.invalidated)
        assertTrue(sentinel.invalidated)
        assertFalse(keyEraser.erased)

        val recovering = sessionManager(securePrefs, invalidation)
        recovering.saveAuthSuccess(alice(), "fresh-token")

        assertFalse(marker.invalidated)
        assertFalse(sentinel.invalidated)
        val restarted = sessionManager(securePrefs, invalidation)
        assertEquals(SessionStorageState.AVAILABLE, restarted.storageState.value)
        assertEquals("fresh-token", restarted.token)
        assertEquals(alice(), restarted.currentUser)
    }

    @Test
    fun freshLoginCompletesRecoveryBeforeMarkersAreCleared() {
        val securePrefs = CommitControlledSharedPreferences()
        val marker = MemorySessionInvalidationMarker(initiallyInvalidated = true)
        val sentinel = MemorySessionInvalidationSentinel(initiallyInvalidated = true)
        val invalidation = FailClosedSessionInvalidationStore(
            marker = marker,
            keyEraser = SuccessfulKeyEraser,
            sentinel = sentinel
        )
        val recovering = sessionManager(securePrefs, invalidation)

        assertEquals(
            NavKey.Login,
            SessionRouteGuard.destinationForNavigation(
                requestedDestination = NavKey.Conversations,
                session = AuthenticatedRouteState(
                    token = recovering.token,
                    hasCurrentUser = recovering.currentUser != null,
                    storageState = recovering.storageState.value
                )
            )
        )
        val ephemeralDeviceId = recovering.deviceId
        recovering.saveAuthSuccess(alice(), "fresh-token")

        assertEquals(SessionStorageState.AVAILABLE, recovering.storageState.value)
        assertEquals("https://chat.example/api", recovering.serverUrl)
        assertFalse(marker.invalidated)
        assertFalse(sentinel.invalidated)
        val restarted = sessionManager(securePrefs, invalidation)
        assertEquals(SessionStorageState.AVAILABLE, restarted.storageState.value)
        assertEquals("fresh-token", restarted.token)
        assertEquals(alice(), restarted.currentUser)
        assertEquals("https://chat.example/api", restarted.serverUrl)
        assertEquals(ephemeralDeviceId, restarted.deviceId)
    }

    @Test
    fun noBackupSentinelBlocksRestartWhenMarkerAndKeyErasureBothFail() {
        val securePrefs = CommitControlledSharedPreferences()
        val marker = FailingSessionInvalidationMarker()
        val sentinel = MemorySessionInvalidationSentinel(initiallyInvalidated = false)
        val invalidation = FailClosedSessionInvalidationStore(
            marker = marker,
            keyEraser = FailingKeyEraser,
            sentinel = sentinel
        )
        val seeded = sessionManager(securePrefs, invalidation)
        seeded.saveAuthSuccess(alice(), "stale-token")
        securePrefs.failNextCommit = true

        assertFalse(seeded.clearSession())
        assertTrue(sentinel.invalidated)
        val restarted = sessionManager(securePrefs, invalidation)

        assertEquals(SessionStorageState.UNAVAILABLE, restarted.storageState.value)
        assertNull(restarted.token)
        assertNull(restarted.currentUser)
    }

    @Test
    fun invalidatedStoreRecoversThroughAFreshLoginBeforeNavigation() = runBlocking {
        Dispatchers.setMain(Dispatchers.Unconfined)
        try {
            val securePrefs = CommitControlledSharedPreferences()
            val marker = MemorySessionInvalidationMarker(initiallyInvalidated = true)
            val sentinel = MemorySessionInvalidationSentinel(initiallyInvalidated = true)
            val invalidation = FailClosedSessionInvalidationStore(
                marker = marker,
                keyEraser = SuccessfulKeyEraser,
                sentinel = sentinel
            )
            val sessionManager = sessionManager(securePrefs, invalidation)

            assertEquals("https://chat.example/api", sessionManager.serverUrl)
            assertEquals(SessionStorageState.UNAVAILABLE, sessionManager.storageState.value)

            val login = LoginViewModel(
                loginPreferences = com.openmychat.mobile.testing.FakeLoginPreferences(),
                authRepository = DefaultAuthRepository(ApiClient(sessionManager, okHttpClient = loginClient()), sessionManager))
            login.login("alice", "password")
            withTimeout(2_000) { login.uiState.first { it is LoginUiState.Success } }

            assertEquals(SessionStorageState.AVAILABLE, sessionManager.storageState.value)
            assertFalse(marker.invalidated)
            assertFalse(sentinel.invalidated)
            val restarted = sessionManager(securePrefs, invalidation)
            assertEquals("fresh-token", restarted.token)
            assertEquals(alice(), restarted.currentUser)
        } finally {
            Dispatchers.resetMain()
        }
    }

    private fun assertRestartIsUnauthenticated(
        securePrefs: CommitControlledSharedPreferences,
        invalidation: MemorySessionInvalidation
    ) {
        val restarted = sessionManager(securePrefs, invalidation)

        assertEquals(SessionStorageState.UNAVAILABLE, restarted.storageState.value)
        assertNull(restarted.token)
        assertNull(restarted.currentUser)
        assertFalse(
            SessionRouteGuard.hasAuthenticatedSession(
                AuthenticatedRouteState(
                    token = restarted.token,
                    hasCurrentUser = restarted.currentUser != null,
                    storageState = restarted.storageState.value
                )
            )
        )
    }

    private fun sessionManager(
        securePrefs: SharedPreferences,
        invalidation: SessionInvalidationStore
    ): SessionManager {
        val constructor = SessionManager::class.java.declaredConstructors.singleOrNull { candidate ->
            candidate.parameterTypes.contentEquals(
                arrayOf(
                    SharedPreferences::class.java,
                    ValidatedEndpoint::class.java,
                    SessionInvalidationStore::class.java
                )
            )
        } ?: throw AssertionError("SessionManager must support injected persistent invalidation for restart tests")
        constructor.isAccessible = true
        return constructor.newInstance(securePrefs, TestSessions.CHAT_EXAMPLE, invalidation) as SessionManager
    }

    private fun assertStorageFailure(operation: () -> Unit) {
        try {
            operation()
            fail("a failed secure write must be surfaced to the caller")
        } catch (_: SecureStorageUnavailableException) {
            // Expected: protected state cannot be trusted after a failed commit.
        }
    }

    private fun alice() = User(id = 1, username = "alice", fullName = "Alice")

    private fun loginClient(): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            val body = when (chain.request().url.encodedPath) {
                "/api/auth/login" ->
                    """{"user":{"id":1,"username":"alice","full_name":"Alice"},"token":"fresh-token"}"""
                "/api/auth/device/claim" -> """{"claimed":false}"""
                else -> error("Unexpected login endpoint: ${chain.request().url}")
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

    private class MemorySessionInvalidation : SessionInvalidationStore {
        var invalidated = false

        override fun isInvalidated(): Boolean = invalidated

        override fun invalidate(): Boolean {
            invalidated = true
            return true
        }

        override fun clear(): Boolean {
            invalidated = false
            return true
        }
    }

    private class FailingSessionInvalidationMarker : SessionInvalidationMarker {
        override fun isInvalidated(): Boolean = false
        override fun markInvalidated(): Boolean = false
        override fun clearInvalidation(): Boolean = false
    }

    private class MemorySessionInvalidationMarker(
        initiallyInvalidated: Boolean
    ) : SessionInvalidationMarker {
        var invalidated = initiallyInvalidated

        override fun isInvalidated(): Boolean = invalidated
        override fun markInvalidated(): Boolean = true.also { invalidated = true }
        override fun clearInvalidation(): Boolean = true.also { invalidated = false }
    }

    private class FailingSessionInvalidationSentinel : SessionInvalidationSentinel {
        override fun isInvalidated(): Boolean = false
        override fun markInvalidated(): Boolean = false
        override fun clearInvalidation(): Boolean = false
    }

    private class MemorySessionInvalidationSentinel(
        initiallyInvalidated: Boolean
    ) : SessionInvalidationSentinel {
        var invalidated = initiallyInvalidated

        override fun isInvalidated(): Boolean = invalidated
        override fun markInvalidated(): Boolean = true.also { invalidated = true }
        override fun clearInvalidation(): Boolean = true.also { invalidated = false }
    }

    private object SuccessfulKeyEraser : SessionKeyEraser {
        override fun erase(): Boolean = true
    }

    private object FailingKeyEraser : SessionKeyEraser {
        override fun erase(): Boolean = false
    }

    private class RecordingKeyEraser(
        private val onErase: () -> Unit
    ) : SessionKeyEraser {
        var erased = false

        override fun erase(): Boolean {
            erased = true
            onErase()
            return true
        }
    }

    private class CommitControlledSharedPreferences : SharedPreferences {
        private val values = mutableMapOf<String, Any?>()
        var commits = 0
        var failNextCommit = false
        var failCommitNumber: Int? = null
        var unreadable = false

        override fun getAll(): MutableMap<String, *> = values
        override fun getString(key: String, defValue: String?): String? {
            check(!unreadable) { "old encrypted entries cannot be read after key erasure" }
            return values[key] as? String ?: defValue
        }
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? =
            (values[key] as? Set<*>)?.filterIsInstance<String>()?.toMutableSet() ?: defValues
        override fun getInt(key: String, defValue: Int): Int = values[key] as? Int ?: defValue
        override fun getLong(key: String, defValue: Long): Long = values[key] as? Long ?: defValue
        override fun getFloat(key: String, defValue: Float): Float = values[key] as? Float ?: defValue
        override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
        override fun contains(key: String): Boolean = values.containsKey(key)
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            private val pending = mutableMapOf<String, Any?>()
            private var clearAll = false

            override fun putString(key: String, value: String?): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = apply { pending[key] = values }
            override fun putInt(key: String, value: Int): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putLong(key: String, value: Long): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = apply { pending[key] = value }
            override fun remove(key: String): SharedPreferences.Editor = apply { pending[key] = Removed }
            override fun clear(): SharedPreferences.Editor = apply { clearAll = true }
            override fun commit(): Boolean {
                commits += 1
                val shouldFail = failNextCommit || failCommitNumber == commits
                failNextCommit = false
                if (shouldFail) return false
                if (clearAll) values.clear()
                pending.forEach { (key, value) ->
                    if (value === Removed) values.remove(key) else values[key] = value
                }
                return true
            }
            override fun apply() = Unit
        }

        private object Removed
    }
}
