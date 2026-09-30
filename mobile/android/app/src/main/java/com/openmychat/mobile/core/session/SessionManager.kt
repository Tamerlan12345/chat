package com.openmychat.mobile.core.session

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
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
        _serverUrlFlow.value = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL

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
        get() = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(value) {
            val sanitized = value.trim().removeSuffix("/")
            prefs.edit().putString(KEY_SERVER_URL, sanitized).apply()
            _serverUrlFlow.value = sanitized
        }

    val wsUrl: String
        get() {
            val base = serverUrl
            val cleanBase = if (base.endsWith("/api")) base.removeSuffix("/api") else base
            val wsScheme = if (cleanBase.startsWith("https://")) "wss://" else "ws://"
            val hostAndPort = cleanBase.substringAfter("://")
            return "$wsScheme$hostAndPort/ws"
        }

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
                    setMustChangePassword(true)
                }
            } else {
                prefs.edit().remove(KEY_CURRENT_USER).apply()
            }
        }

    var mustChangePassword: Boolean
        get() = _mustChangePasswordFlow.value
        set(value) {
            setMustChangePassword(value)
        }

    fun setMustChangePassword(mustChange: Boolean) {
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
            setMustChangePassword(true)
        } else {
            setMustChangePassword(false)
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
        const val DEFAULT_SERVER_URL = "http://10.0.2.2:2004/api"
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
