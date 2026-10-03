package com.openmychat.mobile.core.session

import android.content.Context
import android.content.SharedPreferences
import android.util.AtomicFile
import java.io.File
import java.io.FileOutputStream
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

internal interface SessionInvalidationSentinel {
    fun isInvalidated(): Boolean
    fun markInvalidated(): Boolean
    fun clearInvalidation(): Boolean
}

/**
 * Fails closed across a process restart using three independent non-secret primitives: a regular
 * state marker, cryptographic key erasure, and a marker in Android's no-backup file directory.
 * The sentinel is written even when another primitive succeeds, so a failure of the first marker
 * and key erasure cannot revive old encrypted credentials after a process restart.
 *
 * Residual Android platform assumption: a successful `SharedPreferences.commit()` survives
 * process death, a successful `AndroidKeyStore.deleteEntry()` irreversibly destroys key material,
 * or a successful no-backup `AtomicFile` write survives process death. If all three independent
 * Android primitives fail together, the current process remains unauthenticated; no application
 * can prove durable erasure until at least one primitive is again available.
 */
internal class FailClosedSessionInvalidationStore(
    private val marker: SessionInvalidationMarker,
    private val keyEraser: SessionKeyEraser,
    private val sentinel: SessionInvalidationSentinel
) : SessionInvalidationStore {
    internal constructor(
        marker: SessionInvalidationMarker,
        keyEraser: SessionKeyEraser
    ) : this(marker, keyEraser, NoOpSessionInvalidationSentinel)

    override fun isInvalidated(): Boolean {
        val markerInvalidated = runCatching { marker.isInvalidated() }.getOrDefault(true)
        val sentinelInvalidated = runCatching { sentinel.isInvalidated() }.getOrDefault(true)
        return markerInvalidated || sentinelInvalidated
    }

    override fun invalidate(): Boolean {
        val markerPersisted = runCatching { marker.markInvalidated() }.getOrDefault(false)
        val sentinelPersisted = runCatching { sentinel.markInvalidated() }.getOrDefault(false)
        val keyErased = if (!markerPersisted && !sentinelPersisted) {
            runCatching { keyEraser.erase() }.getOrDefault(false)
        } else {
            false
        }
        return markerPersisted || keyErased || sentinelPersisted
    }

    override fun clear(): Boolean {
        val markerCleared = runCatching { marker.clearInvalidation() }.getOrDefault(false)
        val sentinelCleared = runCatching { sentinel.clearInvalidation() }.getOrDefault(false)
        return markerCleared && sentinelCleared
    }
}

internal object NoOpSessionInvalidationStore : SessionInvalidationStore {
    override fun isInvalidated(): Boolean = false
    override fun invalidate(): Boolean = false
    override fun clear(): Boolean = true
}

private object NoOpSessionInvalidationSentinel : SessionInvalidationSentinel {
    override fun isInvalidated(): Boolean = false
    override fun markInvalidated(): Boolean = false
    override fun clearInvalidation(): Boolean = true
}

internal fun createSessionInvalidationStore(context: Context): SessionInvalidationStore =
    FailClosedSessionInvalidationStore(
        marker = SharedPreferencesSessionInvalidationMarker(
            context.applicationContext.getSharedPreferences(
                INVALIDATION_PREFERENCES_NAME,
                Context.MODE_PRIVATE
            )
        ),
        keyEraser = AndroidKeyStoreSessionKeyEraser(SECURE_SESSION_MASTER_KEY_ALIAS),
        sentinel = NoBackupFileSessionInvalidationSentinel(context.applicationContext)
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

private class NoBackupFileSessionInvalidationSentinel(context: Context) : SessionInvalidationSentinel {
    private val markerFile = File(context.noBackupFilesDir, NO_BACKUP_SENTINEL_FILE_NAME)
    private val backupFile = File("${markerFile.path}.bak")
    private val newFile = File("${markerFile.path}.new")
    private val atomicFile = AtomicFile(markerFile)

    override fun isInvalidated(): Boolean =
        markerFile.isFile || backupFile.isFile || newFile.isFile

    override fun markInvalidated(): Boolean {
        var output: FileOutputStream? = null
        return try {
            output = atomicFile.startWrite()
            output.write(NO_BACKUP_SENTINEL_CONTENT)
            output.fd.sync()
            atomicFile.finishWrite(output)
            true
        } catch (_: Exception) {
            output?.let(atomicFile::failWrite)
            false
        }
    }

    override fun clearInvalidation(): Boolean = try {
        atomicFile.delete()
        !markerFile.exists() && !backupFile.exists() && !newFile.exists()
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
private const val NO_BACKUP_SENTINEL_FILE_NAME = "centychat_session_invalidated"
private val NO_BACKUP_SENTINEL_CONTENT = byteArrayOf(1)
