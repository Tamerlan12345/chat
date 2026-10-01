package com.openmychat.mobile.core.session

import android.content.Context
import android.content.SharedPreferences
import java.security.KeyStore

/**
 * A non-sensitive, durable record that tells a new process never to restore a prior session.
 *
 * Implementations must return true from [invalidate] only when a durable marker was written or
 * the key that encrypts the old session was erased. Neither mechanism stores credentials.
 */
internal interface SessionInvalidationStore {
    fun isInvalidated(): Boolean
    fun invalidate(): Boolean
    fun clear(): Boolean
}

internal interface SessionInvalidationMarker {
    fun isInvalidated(): Boolean
    fun markInvalidated(): Boolean
    fun clearInvalidation(): Boolean
}

internal interface SessionKeyEraser {
    fun erase(): Boolean
}

/**
 * Fails closed across a process restart. The ordinary marker is sufficient when its synchronous
 * commit succeeds. If that commit itself fails, erasing the Android Keystore key makes every
 * value in the previous encrypted preference file cryptographically unreadable.
 *
 * Residual Android platform assumption: a successful `SharedPreferences.commit()` survives
 * process death, or a successful `AndroidKeyStore.deleteEntry()` irreversibly destroys key
 * material. If both platform stores are simultaneously unavailable, the current process remains
 * unauthenticated, but no application code can prove durable erasure until the operating system
 * accepts one of those writes; the user must restore secure device storage or clear app data.
 */
internal class FailClosedSessionInvalidationStore(
    private val marker: SessionInvalidationMarker,
    private val keyEraser: SessionKeyEraser
) : SessionInvalidationStore {
    override fun isInvalidated(): Boolean = try {
        marker.isInvalidated()
    } catch (_: Exception) {
        // An unreadable invalidation marker cannot be treated as authorization.
        true
    }

    override fun invalidate(): Boolean =
        isInvalidated() || runCatching { marker.markInvalidated() }.getOrDefault(false) ||
            runCatching { keyEraser.erase() }.getOrDefault(false)

    override fun clear(): Boolean = runCatching { marker.clearInvalidation() }.getOrDefault(false)
}

internal object NoOpSessionInvalidationStore : SessionInvalidationStore {
    override fun isInvalidated(): Boolean = false
    override fun invalidate(): Boolean = false
    override fun clear(): Boolean = true
}

internal fun createSessionInvalidationStore(context: Context): SessionInvalidationStore =
    FailClosedSessionInvalidationStore(
        marker = SharedPreferencesSessionInvalidationMarker(
            context.applicationContext.getSharedPreferences(
                INVALIDATION_PREFERENCES_NAME,
                Context.MODE_PRIVATE
            )
        ),
        keyEraser = AndroidKeyStoreSessionKeyEraser(SECURE_SESSION_MASTER_KEY_ALIAS)
    )

private class SharedPreferencesSessionInvalidationMarker(
    private val preferences: SharedPreferences
) : SessionInvalidationMarker {
    override fun isInvalidated(): Boolean = preferences.getBoolean(KEY_SESSION_INVALIDATED, false)

    override fun markInvalidated(): Boolean = preferences.edit()
        .putBoolean(KEY_SESSION_INVALIDATED, true)
        .commit()

    override fun clearInvalidation(): Boolean = preferences.edit()
        .remove(KEY_SESSION_INVALIDATED)
        .commit()
}

private class AndroidKeyStoreSessionKeyEraser(
    private val keyAlias: String
) : SessionKeyEraser {
    override fun erase(): Boolean = try {
        KeyStore.getInstance(ANDROID_KEYSTORE).apply {
            load(null)
            if (containsAlias(keyAlias)) deleteEntry(keyAlias)
        }
        true
    } catch (_: Exception) {
        false
    }
}

// This is AndroidX MasterKey's historical default alias. Keeping it preserves existing encrypted
// session data until it is explicitly invalidated, and this app has no other MasterKey consumer.
internal const val SECURE_SESSION_MASTER_KEY_ALIAS = "_androidx_security_master_key_"

private const val INVALIDATION_PREFERENCES_NAME = "centychat_session_invalidation"
private const val KEY_SESSION_INVALIDATED = "session_invalidated"
private const val ANDROID_KEYSTORE = "AndroidKeyStore"
