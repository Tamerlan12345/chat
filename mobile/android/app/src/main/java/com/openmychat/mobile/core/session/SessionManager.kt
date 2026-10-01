package com.openmychat.mobile.core.session

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import android.content.pm.ApplicationInfo
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

class SessionManager internal constructor(
    private val prefs: SharedPreferences?,
    private val isDebuggableBuild: Boolean
) {

    constructor(context: Context) : this(
        prefs = createEncryptedPreferences(context),
        isDebuggableBuild = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
    )

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private val _storageState = MutableStateFlow(
        if (prefs == null) SessionStorageState.UNAVAILABLE else SessionStorageState.AVAILABLE
    )
    val storageState: StateFlow<SessionStorageState> = _storageState.asStateFlow()

    private val _tokenFlow = MutableStateFlow<String?>(null)
    val tokenFlow: StateFlow<String?> = _tokenFlow.asStateFlow()

    private val _currentUserFlow = MutableStateFlow<User?>(null)
    val currentUserFlow: StateFlow<User?> = _currentUserFlow.asStateFlow()

    private val _mustChangePasswordFlow = MutableStateFlow(false)
    val mustChangePasswordFlow: StateFlow<Boolean> = _mustChangePasswordFlow.asStateFlow()

    private val _serverUrlFlow = MutableStateFlow(DEFAULT_SERVER_URL)
    val serverUrlFlow: StateFlow<String> = _serverUrlFlow.asStateFlow()

    init {
        _tokenFlow.value = readString(KEY_TOKEN)
        _mustChangePasswordFlow.value = readBoolean(KEY_MUST_CHANGE_PASSWORD, false)
        restorePersistedServerEndpoint()

        val userJson = readString(KEY_CURRENT_USER)
        if (!userJson.isNullOrBlank()) {
            try {
                _currentUserFlow.value = json.decodeFromString<User>(userJson)
            } catch (e: Exception) {
                _currentUserFlow.value = null
            }
        }
    }

    private fun markStorageUnavailable() {
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

    private fun editSecureStorage(change: SharedPreferences.Editor.() -> Unit): Boolean {
        if (_storageState.value == SessionStorageState.UNAVAILABLE) return false
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

    var serverUrl: String
        get() = _serverUrlFlow.value
        set(value) {
            validateServerEndpoint(value).onSuccess(::useServerEndpointForVerification)
        }

    fun validateServerEndpoint(raw: String): Result<ValidatedEndpoint> =
        ServerEndpointPolicy.validate(raw, allowInsecureDebug = isDebuggableBuild)

    fun useServerEndpointForVerification(endpoint: ValidatedEndpoint) {
        _serverUrlFlow.value = endpoint.apiBaseUrl
    }

    fun commitVerifiedServerEndpoint(endpoint: ValidatedEndpoint) {
        if (!writeString(KEY_SERVER_URL, endpoint.apiBaseUrl)) {
            throw SecureStorageUnavailableException()
        }
        _serverUrlFlow.value = endpoint.apiBaseUrl
    }

    fun restorePersistedServerEndpoint() {
        val stored = readString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        val endpoint = validateServerEndpoint(stored).getOrNull()
        if (endpoint == null && stored.isNotBlank()) {
            writeString(KEY_SERVER_URL, null)
        }
        _serverUrlFlow.value = endpoint?.apiBaseUrl ?: DEFAULT_SERVER_URL
    }

    val wsUrl: String
        get() = validateServerEndpoint(serverUrl).getOrNull()?.webSocketUrl
            ?: error("A verified server endpoint is required before opening a WebSocket")

    var token: String?
        get() = readString(KEY_TOKEN)
        set(value) {
            if (writeString(KEY_TOKEN, value)) {
                _tokenFlow.value = value
            }
        }

    val deviceId: String
        get() {
            var id = readString(KEY_DEVICE_ID)
            if (id.isNullOrBlank()) {
                id = UUID.randomUUID().toString()
                writeString(KEY_DEVICE_ID, id)
            }
            return id
        }

    var deviceSecret: String?
        get() = readString(KEY_DEVICE_SECRET)
        set(value) {
            writeString(KEY_DEVICE_SECRET, value)
        }

    var currentUser: User?
        get() = _currentUserFlow.value
        set(value) {
            if (value != null) {
                val encoded = json.encodeToString(value)
                if (writeString(KEY_CURRENT_USER, encoded)) {
                    _currentUserFlow.value = value
                    if (value.mustChangePassword) {
                        updateMustChangePassword(true)
                    }
                }
            } else {
                if (writeString(KEY_CURRENT_USER, null)) {
                    _currentUserFlow.value = null
                }
            }
        }

    var mustChangePassword: Boolean
        get() = _mustChangePasswordFlow.value
        set(value) {
            updateMustChangePassword(value)
        }

    private fun updateMustChangePassword(mustChange: Boolean) {
        if (writeBoolean(KEY_MUST_CHANGE_PASSWORD, mustChange)) {
            _mustChangePasswordFlow.value = mustChange
        }
    }

    var messageEditWindowMinutes: String
        get() = readString(KEY_MSG_EDIT_WINDOW, "60") ?: "60"
        set(value) {
            writeString(KEY_MSG_EDIT_WINDOW, value)
        }

    var messageDeleteWindowMinutes: String
        get() = readString(KEY_MSG_DELETE_WINDOW, "60") ?: "60"
        set(value) {
            writeString(KEY_MSG_DELETE_WINDOW, value)
        }

    fun saveAuthSuccess(user: User, token: String) {
        val encodedUser = json.encodeToString(user)
        if (!editSecureStorage {
                putString(KEY_TOKEN, token)
                putString(KEY_CURRENT_USER, encodedUser)
                putBoolean(KEY_MUST_CHANGE_PASSWORD, user.mustChangePassword)
            }
        ) throw SecureStorageUnavailableException()

        _tokenFlow.value = token
        _currentUserFlow.value = user
        _mustChangePasswordFlow.value = user.mustChangePassword
    }

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
            val masterKey = MasterKey.Builder(context)
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

        const val DEFAULT_SERVER_URL = ""
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
