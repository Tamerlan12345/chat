package com.openmychat.mobile.features.auth

import android.content.SharedPreferences

/**
 * Login conveniences kept in ordinary (non-encrypted) preferences. Only the last login name is
 * stored, and only after a successful sign-in; the password never is. Tokens and the device secret
 * live in the encrypted session store.
 */
interface LoginPreferences {
    var lastUsername: String?
}

class SharedPreferencesLoginPreferences(private val prefs: SharedPreferences) : LoginPreferences {
    override var lastUsername: String?
        get() = try {
            prefs.getString(KEY_LAST_USERNAME, null)?.takeIf { it.isNotBlank() && it.length <= MAX_LENGTH }
        } catch (_: Exception) {
            null
        }
        set(value) {
            val cleaned = value?.trim()?.takeIf { it.isNotEmpty() && it.length <= MAX_LENGTH }
            try {
                prefs.edit().apply {
                    if (cleaned == null) remove(KEY_LAST_USERNAME) else putString(KEY_LAST_USERNAME, cleaned)
                }.apply()
            } catch (_: Exception) {
                // A convenience only: failing to remember the name must not fail the sign-in.
            }
        }

    companion object {
        const val FILE_NAME = "centychat_login"
        private const val KEY_LAST_USERNAME = "last_username"

        /** The server's own limit on login names (server/src/api/index.js). */
        private const val MAX_LENGTH = 256
    }
}
