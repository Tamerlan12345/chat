package com.openmychat.mobile.core.session

import android.content.SharedPreferences
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.ui.navigation.AuthenticatedRouteState
import com.openmychat.mobile.ui.navigation.SessionRouteGuard
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
    fun failedInvalidationMarkerErasesEncryptionKeyBeforeAProcessCanRestoreCredentials() {
        val securePrefs = CommitControlledSharedPreferences()
        val keyEraser = RecordingKeyEraser { securePrefs.unreadable = true }
        val invalidation = FailClosedSessionInvalidationStore(
            marker = FailingSessionInvalidationMarker(),
            keyEraser = keyEraser
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
                    Boolean::class.javaPrimitiveType,
                    SessionInvalidationStore::class.java
                )
            )
        } ?: throw AssertionError("SessionManager must support injected persistent invalidation for restart tests")
        constructor.isAccessible = true
        return constructor.newInstance(securePrefs, false, invalidation) as SessionManager
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
