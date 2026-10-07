package com.openmychat.mobile.core.session

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.openmychat.mobile.core.config.ServerConfig
import com.openmychat.mobile.core.network.ServerEndpointPolicy
import com.openmychat.mobile.core.network.ValidatedEndpoint
import com.openmychat.mobile.data.model.User
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID

enum class SessionStorageState {
    AVAILABLE,
    UNAVAILABLE
}

class SecureStorageUnavailableException : IllegalStateException(
    "Secure device storage is unavailable. Unlock the device or restore screen lock, then try again."
)

/**
 * Fail-closed encrypted store for the session (token, user, device secret).
 *
 * The server is fixed at build time ([ServerConfig]); [serverEndpoint] is never read from storage.
 * The stored `server_url` only records which server issued the stored credentials: anything issued
 * by another server (an older install's custom address, or a debug build pointed elsewhere) is
 * wiped on start, so the user signs in again instead of sending a token to the wrong host.
 */
class SessionManager private constructor(
    private val prefs: SharedPreferences?,
    val serverEndpoint: ValidatedEndpoint,
    private val invalidationStore: SessionInvalidationStore,
    @Suppress("UNUSED_PARAMETER") private val constructorMarker: Unit
) {

    internal constructor(
        prefs: SharedPreferences?,
        serverEndpoint: ValidatedEndpoint
    ) : this(prefs, serverEndpoint, NoOpSessionInvalidationStore, Unit)

    internal constructor(
        prefs: SharedPreferences?,
        serverEndpoint: ValidatedEndpoint,
        invalidationStore: SessionInvalidationStore
    ) : this(prefs, serverEndpoint, invalidationStore, Unit)

    constructor(context: Context) : this(
        prefs = createEncryptedPreferences(context),
        serverEndpoint = ServerConfig.endpoint,
        invalidationStore = createSessionInvalidationStore(context),
        constructorMarker = Unit
    )

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private val _storageState = MutableStateFlow(
        if (prefs == null || isPersistentlyInvalidated()) {
            SessionStorageState.UNAVAILABLE
        } else {
            SessionStorageState.AVAILABLE
        }
    )
    val storageState: StateFlow<SessionStorageState> = _storageState.asStateFlow()

    private val _tokenFlow = MutableStateFlow<String?>(null)
    val tokenFlow: StateFlow<String?> = _tokenFlow.asStateFlow()

    private val _currentUserFlow = MutableStateFlow<User?>(null)
    val currentUserFlow: StateFlow<User?> = _currentUserFlow.asStateFlow()

    private val _mustChangePasswordFlow = MutableStateFlow(false)
    val mustChangePasswordFlow: StateFlow<Boolean> = _mustChangePasswordFlow.asStateFlow()

    private var ephemeralDeviceId: String? = null

    init {
        if (_storageState.value == SessionStorageState.AVAILABLE) {
            discardCredentialsIssuedByAnotherServer()
        }
        if (_storageState.value == SessionStorageState.AVAILABLE) {
            _tokenFlow.value = readString(KEY_TOKEN)
            _mustChangePasswordFlow.value = readBoolean(KEY_MUST_CHANGE_PASSWORD, false)

            val userJson = readString(KEY_CURRENT_USER)
            if (!userJson.isNullOrBlank()) {
                try {
                    _currentUserFlow.value = json.decodeFromString<User>(userJson)
                } catch (e: Exception) {
                    _currentUserFlow.value = null
                }
            }
        }
    }

    /**
     * A token, user or device secret is only valid on the server that issued it. If the stored
     * credentials were issued by a different server, or carry no record of their server (they can
     * only come from an older install), they are removed in one commit and the user signs in again.
     * The device id is not a credential and is kept. A failed commit fails closed.
     */
    private fun discardCredentialsIssuedByAnotherServer() {
        val stored = readString(KEY_SERVER_URL)
        val issuedBy = stored?.let {
            ServerEndpointPolicy.validate(it, allowInsecureDebug = true).getOrNull()?.apiBaseUrl
        }
        if (issuedBy == serverEndpoint.apiBaseUrl) return
        val holdsCredentials = listOf(KEY_TOKEN, KEY_CURRENT_USER, KEY_DEVICE_SECRET)
            .any { !readString(it).isNullOrEmpty() }
        if (stored == null && !holdsCredentials) return
        editSecureStorage {
            remove(KEY_TOKEN)
            remove(KEY_CURRENT_USER)
            remove(KEY_MUST_CHANGE_PASSWORD)
            remove(KEY_DEVICE_SECRET)
            remove(KEY_MSG_EDIT_WINDOW)
            remove(KEY_MSG_DELETE_WINDOW)
            putString(KEY_SERVER_URL, serverEndpoint.apiBaseUrl)
        }
    }

    private fun isPersistentlyInvalidated(): Boolean = try {
        invalidationStore.isInvalidated()
    } catch (_: Exception) {
        true
    }

    private fun markStorageUnavailable(persistInvalidation: Boolean = true) {
        if (persistInvalidation) {
            invalidationStore.invalidate()
        }
        _storageState.value = SessionStorageState.UNAVAILABLE
        _tokenFlow.value = null
        _currentUserFlow.value = null
        _mustChangePasswordFlow.value = false
    }

    private fun readString(key: String, defaultValue: String? = null): String? =
        if (_storageState.value == SessionStorageState.UNAVAILABLE) defaultValue else
        try {
            prefs?.getString(key, defaultValue) ?: defaultValue
        } catch (_: Exception) {
            markStorageUnavailable()
            defaultValue
        }

    private fun readBoolean(key: String, defaultValue: Boolean): Boolean =
        if (_storageState.value == SessionStorageState.UNAVAILABLE) defaultValue else
        try {
            prefs?.getBoolean(key, defaultValue) ?: defaultValue
        } catch (_: Exception) {
            markStorageUnavailable()
            defaultValue
        }

    private fun editSecureStorage(
        allowRecoveryFromPersistentInvalidation: Boolean = false,
        change: SharedPreferences.Editor.() -> Unit
    ): Boolean {
        if (_storageState.value == SessionStorageState.UNAVAILABLE && !allowRecoveryFromPersistentInvalidation) return false
        val securePrefs = prefs ?: run {
            markStorageUnavailable()
            return false
        }
        return try {
            val editor = securePrefs.edit()
            editor.change()
            if (editor.commit()) true else {
                markStorageUnavailable()
                false
            }
        } catch (_: Exception) {
            markStorageUnavailable()
            false
        }
    }

    private fun writeString(key: String, value: String?): Boolean =
        editSecureStorage {
            if (value == null) remove(key) else putString(key, value)
        }

    private fun writeBoolean(key: String, value: Boolean): Boolean =
        editSecureStorage { putBoolean(key, value) }

    /** API base URL of the build-time server, e.g. `https://host/api`. */
    val serverUrl: String
        get() = serverEndpoint.apiBaseUrl

    val wsUrl: String
        get() = serverEndpoint.webSocketUrl

    var token: String?
        get() = readString(KEY_TOKEN)
        set(value) {
            if (!writeString(KEY_TOKEN, value)) throw SecureStorageUnavailableException()
            _tokenFlow.value = value
        }

    val deviceId: String
        get() {
            if (_storageState.value == SessionStorageState.UNAVAILABLE && isPersistentlyInvalidated()) {
                return ephemeralDeviceId ?: UUID.randomUUID().toString().also {
                    // Device IDs are non-secret, but must remain memory-only until recovery commits.
                    ephemeralDeviceId = it
                }
            }
            var id = readString(KEY_DEVICE_ID)
            if (id.isNullOrBlank()) {
                id = UUID.randomUUID().toString()
                if (!writeString(KEY_DEVICE_ID, id)) throw SecureStorageUnavailableException()
            }
            return id
        }

    var deviceSecret: String?
        get() = readString(KEY_DEVICE_SECRET)
        set(value) {
            if (!writeString(KEY_DEVICE_SECRET, value)) throw SecureStorageUnavailableException()
        }

    var currentUser: User?
        get() = _currentUserFlow.value
        set(value) {
            if (value != null) {
                val encoded = json.encodeToString(value)
                if (!writeString(KEY_CURRENT_USER, encoded)) throw SecureStorageUnavailableException()
                _currentUserFlow.value = value
                if (value.mustChangePassword) {
                    updateMustChangePassword(true)
                }
            } else {
                if (!writeString(KEY_CURRENT_USER, null)) throw SecureStorageUnavailableException()
                _currentUserFlow.value = null
            }
        }

    var mustChangePassword: Boolean
        get() = _mustChangePasswordFlow.value
        set(value) {
            updateMustChangePassword(value)
        }

    private fun updateMustChangePassword(mustChange: Boolean) {
        if (!writeBoolean(KEY_MUST_CHANGE_PASSWORD, mustChange)) throw SecureStorageUnavailableException()
        _mustChangePasswordFlow.value = mustChange
    }

    var messageEditWindowMinutes: String
        get() = readString(KEY_MSG_EDIT_WINDOW, "60") ?: "60"
        set(value) {
            if (!writeString(KEY_MSG_EDIT_WINDOW, value)) throw SecureStorageUnavailableException()
        }

    var messageDeleteWindowMinutes: String
        get() = readString(KEY_MSG_DELETE_WINDOW, "60") ?: "60"
        set(value) {
            if (!writeString(KEY_MSG_DELETE_WINDOW, value)) throw SecureStorageUnavailableException()
        }

    fun saveAuthSuccess(user: User, token: String) {
        persistAuthenticatedSession(user, token, user.mustChangePassword)
    }

    /**
     * Replaces an authenticated session after server-side credential rotation.
     *
     * Clearing the old session is deliberately committed before the single replacement edit.
     * If the replacement cannot be committed, a later process cannot resurrect the old or
     * partially updated credential set.
     */
    fun replaceAuthenticatedSession(
        user: User?,
        token: String,
        mustChangePassword: Boolean
    ) {
        val authenticatedUser = user ?: _currentUserFlow.value
            ?: throw IllegalStateException("Cannot replace a session without an authenticated user")
        if (!clearSession()) throw SecureStorageUnavailableException()
        persistAuthenticatedSession(authenticatedUser, token, mustChangePassword)
    }

    @Synchronized
    private fun persistAuthenticatedSession(user: User, token: String, mustChangePassword: Boolean) {
        val encodedUser = json.encodeToString(user.copy(mustChangePassword = mustChangePassword))
        val recoveringFromPersistentInvalidation =
            _storageState.value == SessionStorageState.UNAVAILABLE && isPersistentlyInvalidated()
        if (recoveringFromPersistentInvalidation) {
            commitRecoveredAuthenticatedSession(
                user = user,
                token = token,
                mustChangePassword = mustChangePassword,
                encodedUser = encodedUser
            )
            return
        }
        if (!editSecureStorage {
                putString(KEY_SERVER_URL, serverEndpoint.apiBaseUrl)
                putString(KEY_TOKEN, token)
                putString(KEY_CURRENT_USER, encodedUser)
                putBoolean(KEY_MUST_CHANGE_PASSWORD, mustChangePassword)
            }
        ) throw SecureStorageUnavailableException()

        _storageState.value = SessionStorageState.AVAILABLE
        _tokenFlow.value = token
        _currentUserFlow.value = user.copy(mustChangePassword = mustChangePassword)
        _mustChangePasswordFlow.value = mustChangePassword
    }

    /**
     * Commits a clean replacement in one encrypted-preferences transaction before any marker is
     * cleared. A crash before [invalidationStore.clear] remains invalidated; a crash afterwards
     * can restore only this fresh authenticated session for the build-time server.
     */
    private fun commitRecoveredAuthenticatedSession(
        user: User,
        token: String,
        mustChangePassword: Boolean,
        encodedUser: String
    ) {
        if (!editSecureStorage(allowRecoveryFromPersistentInvalidation = true) {
                clear()
                putString(KEY_SERVER_URL, serverEndpoint.apiBaseUrl)
                putString(KEY_TOKEN, token)
                putString(KEY_CURRENT_USER, encodedUser)
                putBoolean(KEY_MUST_CHANGE_PASSWORD, mustChangePassword)
                ephemeralDeviceId?.let { putString(KEY_DEVICE_ID, it) }
            }
        ) throw SecureStorageUnavailableException()

        if (!invalidationStore.clear()) {
            markStorageUnavailable()
            throw SecureStorageUnavailableException()
        }

        _storageState.value = SessionStorageState.AVAILABLE
        _tokenFlow.value = token
        _currentUserFlow.value = user.copy(mustChangePassword = mustChangePassword)
        _mustChangePasswordFlow.value = mustChangePassword
        ephemeralDeviceId = null
    }

    /**
     * Ends the session only when [token] is still the session's token: a refusal of an older token
     * (another account's, or one already replaced) says nothing about the session signed in now.
     */
    /**
     * Stores a renewed token only while [old] — the token it renews — is still the session's token
     * (review fix round 1). A refresh that lands after a sign-out, or after another account signed in,
     * stores nothing (false). Runs under the same lock as every other change of the session. Throws
     * [SecureStorageUnavailableException] when the store refuses the write.
     */
    @Synchronized
    fun replaceTokenIfCurrent(old: String, new: String): Boolean {
        if (_storageState.value == SessionStorageState.UNAVAILABLE) return false
        if (readString(KEY_TOKEN) != old) return false
        // A store that refuses the write is reported, never a token kept only in memory.
        if (!writeString(KEY_TOKEN, new)) throw SecureStorageUnavailableException()
        _tokenFlow.value = new
        return true
    }

    @Synchronized
    fun clearSessionIfCurrent(token: String): Boolean {
        if (readString(KEY_TOKEN) != token) return true
        return clearSession()
    }

    /**
     * Explicit sign-out: the session and the device secret go together, in one commit, so the login
     * screen's knock cannot sign the same person back in without a password (final review I1). False
     * when the store could not be written — the caller must not report a sign-out then.
     */
    @Synchronized
    fun clearSessionForSignOut(): Boolean {
        val cleared = editSecureStorage {
            remove(KEY_TOKEN)
            remove(KEY_CURRENT_USER)
            remove(KEY_MUST_CHANGE_PASSWORD)
            remove(KEY_DEVICE_SECRET)
        }
        _tokenFlow.value = null
        _currentUserFlow.value = null
        _mustChangePasswordFlow.value = false
        return cleared
    }

    @Synchronized
    fun clearSession(): Boolean {
        val cleared = editSecureStorage {
            remove(KEY_TOKEN)
            remove(KEY_CURRENT_USER)
            remove(KEY_MUST_CHANGE_PASSWORD)
        }
        _tokenFlow.value = null
        _currentUserFlow.value = null
        _mustChangePasswordFlow.value = false
        return cleared
    }

    companion object {
        private fun createEncryptedPreferences(context: Context): SharedPreferences? = try {
            val masterKey = MasterKey.Builder(context, SECURE_SESSION_MASTER_KEY_ALIAS)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()

            EncryptedSharedPreferences.create(
                context,
                "centychat_secure_session",
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (_: Exception) {
            null
        }

        /** Records which server issued the stored credentials; never used to pick the endpoint. */
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_TOKEN = "jwt_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_SECRET = "device_secret"
        private const val KEY_CURRENT_USER = "current_user_json"
        private const val KEY_MUST_CHANGE_PASSWORD = "must_change_password"
        private const val KEY_MSG_EDIT_WINDOW = "msg_edit_window"
        private const val KEY_MSG_DELETE_WINDOW = "msg_delete_window"
    }
}
