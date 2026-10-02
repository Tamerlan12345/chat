package com.openmychat.mobile.testing

import com.openmychat.mobile.core.network.ServerEndpointPolicy
import com.openmychat.mobile.core.network.ValidatedEndpoint
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.User

/** Ready-made session managers for tests that only need "a signed-in user on an HTTPS server". */
object TestSessions {
    /** The server a test build is "fixed" to. */
    val CHAT_EXAMPLE: ValidatedEndpoint =
        ServerEndpointPolicy.validate("https://chat.example", allowInsecureDebug = false).getOrThrow()

    fun authenticated(token: String = "token"): SessionManager =
        SessionManager(prefs = InMemorySharedPreferences(), serverEndpoint = CHAT_EXAMPLE).apply {
            saveAuthSuccess(User(id = 1, username = "alice", fullName = "Alice"), token)
        }
}
