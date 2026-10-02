package com.openmychat.mobile.testing

import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.User

/** Ready-made session managers for tests that only need "a signed-in user on an HTTPS server". */
object TestSessions {
    fun authenticated(token: String = "token"): SessionManager =
        SessionManager(prefs = InMemorySharedPreferences(), isDebuggableBuild = false).apply {
            commitVerifiedServerEndpoint(validateServerEndpoint("https://chat.example").getOrThrow())
            saveAuthSuccess(User(id = 1, username = "alice", fullName = "Alice"), token)
        }
}
