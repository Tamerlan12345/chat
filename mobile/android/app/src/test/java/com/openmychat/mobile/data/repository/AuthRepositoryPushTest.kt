package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.data.push.PushTokenSource
import com.openmychat.mobile.testing.TestSessions
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Review fix round 1 (Ruling U, minor 2): an explicit sign-out deletes this device's FCM token, so the
 * old session's pushes stop even when /auth/logout never reaches the server (offline).
 */
class AuthRepositoryPushTest {

    private class Tokens : PushTokenSource {
        var deleted = 0
        override suspend fun currentToken(): String? = "fcm-token-0123456789abcdefghij"
        override suspend fun delete() {
            deleted++
        }
    }

    private val offline = OkHttpClient.Builder().addInterceptor { throw java.io.IOException("offline") }.build()

    @Test
    fun anOfflineSignOutStillDeletesThePushToken() = runBlocking {
        val session = TestSessions.authenticated()
        val tokens = Tokens()
        DefaultAuthRepository(ApiClient(session, offline), session, tokens).logout()

        assertNull(session.token)
        assertEquals(1, tokens.deleted)
    }

    @Test
    fun aSignOutThatCouldNotClearTheSessionKeepsThePushToken() = runBlocking {
        val prefs = com.openmychat.mobile.testing.InMemorySharedPreferences()
        val session = com.openmychat.mobile.core.session.SessionManager(prefs = prefs, serverEndpoint = TestSessions.CHAT_EXAMPLE).apply {
            saveAuthSuccess(com.openmychat.mobile.data.model.User(id = 1, username = "a", fullName = "A"), "t")
        }
        prefs.failCommits = true
        val tokens = Tokens()
        runCatching { DefaultAuthRepository(ApiClient(session, offline), session, tokens).logout() }
        assertEquals(0, tokens.deleted)
    }
}
