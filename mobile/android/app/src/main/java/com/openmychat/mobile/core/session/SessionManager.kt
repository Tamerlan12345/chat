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

class SessionManager(private val context: Context) {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private val prefs: SharedPreferences by lazy {
        try {
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
        } catch (e: Exception) {
            // Fallback for Robolectric / unit testing or unsupported devices
            context.getSharedPreferences("centychat_fallback_session", Context.MODE_PRIVATE)
        }
    }

    private val _tokenFlow = MutableStateFlow<String?>(null)
    val tokenFlow: StateFlow<String?> = _tokenFlow.asStateFlow()

    private val _currentUserFlow = MutableStateFlow<User?>(null)
    val currentUserFlow: StateFlow<User?> = _currentUserFlow.asStateFlow()

    private val _mustChangePasswordFlow = MutableStateFlow(false)
    val mustChangePasswordFlow: StateFlow<Boolean> = _mustChangePasswordFlow.asStateFlow()

    private val _serverUrlFlow = MutableStateFlow(DEFAULT_SERVER_URL)
    val serverUrlFlow: StateFlow<String> = _serverUrlFlow.asStateFlow()

    init {
        _tokenFlow.value = prefs.getString(KEY_TOKEN, null)
        _mustChangePasswordFlow.value = prefs.getBoolean(KEY_MUST_CHANGE_PASSWORD, false)
        restorePersistedServerEndpoint()

        val userJson = prefs.getString(KEY_CURRENT_USER, null)
        if (!userJson.isNullOrBlank()) {
            try {
                _currentUserFlow.value = json.decodeFromString<User>(userJson)
            } catch (e: Exception) {
                _currentUserFlow.value = null
            }
        }
    }

    var serverUrl: String
        get() = _serverUrlFlow.value
        set(value) {
            validateServerEndpoint(value).onSuccess(::useServerEndpointForVerification)
        }

    fun validateServerEndpoint(raw: String): Result<ValidatedEndpoint> =
        ServerEndpointPolicy.validate(raw, allowInsecureDebug = isDebuggableBuild)

    private val isDebuggableBuild: Boolean
        get() = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    fun useServerEndpointForVerification(endpoint: ValidatedEndpoint) {
        _serverUrlFlow.value = endpoint.apiBaseUrl
    }

    fun commitVerifiedServerEndpoint(endpoint: ValidatedEndpoint) {
        prefs.edit().putString(KEY_SERVER_URL, endpoint.apiBaseUrl).apply()
        _serverUrlFlow.value = endpoint.apiBaseUrl
    }

    fun restorePersistedServerEndpoint() {
        val stored = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        val endpoint = validateServerEndpoint(stored).getOrNull()
        if (endpoint == null && stored.isNotBlank()) {
            prefs.edit().remove(KEY_SERVER_URL).apply()
        }
        _serverUrlFlow.value = endpoint?.apiBaseUrl ?: DEFAULT_SERVER_URL
    }

    val wsUrl: String
        get() = validateServerEndpoint(serverUrl).getOrNull()?.webSocketUrl
            ?: error("A verified server endpoint is required before opening a WebSocket")

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) {
            prefs.edit().putString(KEY_TOKEN, value).apply()
            _tokenFlow.value = value
        }

    val deviceId: String
        get() {
            var id = prefs.getString(KEY_DEVICE_ID, null)
            if (id.isNullOrBlank()) {
                id = UUID.randomUUID().toString()
                prefs.edit().putString(KEY_DEVICE_ID, id).apply()
            }
            return id
        }

    var deviceSecret: String?
        get() = prefs.getString(KEY_DEVICE_SECRET, null)
        set(value) {
            prefs.edit().putString(KEY_DEVICE_SECRET, value).apply()
        }

    var currentUser: User?
        get() = _currentUserFlow.value
        set(value) {
            _currentUserFlow.value = value
            if (value != null) {
                val encoded = json.encodeToString(value)
                prefs.edit().putString(KEY_CURRENT_USER, encoded).apply()
                if (value.mustChangePassword) {
                    updateMustChangePassword(true)
                }
            } else {
                prefs.edit().remove(KEY_CURRENT_USER).apply()
            }
        }

    var mustChangePassword: Boolean
        get() = _mustChangePasswordFlow.value
        set(value) {
            updateMustChangePassword(value)
        }

    private fun updateMustChangePassword(mustChange: Boolean) {
        prefs.edit().putBoolean(KEY_MUST_CHANGE_PASSWORD, mustChange).apply()
        _mustChangePasswordFlow.value = mustChange
    }

    var messageEditWindowMinutes: String
        get() = prefs.getString(KEY_MSG_EDIT_WINDOW, "60") ?: "60"
        set(value) {
            prefs.edit().putString(KEY_MSG_EDIT_WINDOW, value).apply()
        }

    var messageDeleteWindowMinutes: String
        get() = prefs.getString(KEY_MSG_DELETE_WINDOW, "60") ?: "60"
        set(value) {
            prefs.edit().putString(KEY_MSG_DELETE_WINDOW, value).apply()
        }

    fun saveAuthSuccess(user: User, token: String) {
        this.token = token
        this.currentUser = user
        if (user.mustChangePassword) {
            updateMustChangePassword(true)
        } else {
            updateMustChangePassword(false)
        }
    }

    fun clearSession() {
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_CURRENT_USER)
            .remove(KEY_MUST_CHANGE_PASSWORD)
            .apply()
        _tokenFlow.value = null
        _currentUserFlow.value = null
        _mustChangePasswordFlow.value = false
    }

    companion object {
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
