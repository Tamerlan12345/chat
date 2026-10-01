package com.openmychat.mobile.core.network

import android.content.SharedPreferences
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.User
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class ApiClientUnauthorizedSessionTest {

    @Test
    fun unauthorizedResponseClearsSessionBeforeSurfacingTheError() = runBlocking {
        val sessionManager = authenticatedSessionManager()
        val apiClient = ApiClient(sessionManager, unauthorizedResponseClient())

        try {
            apiClient.getDirectConversations()
            fail("A 401 response must surface UnauthorizedException")
        } catch (_: UnauthorizedException) {
            // Expected: the API error remains visible to the caller.
        }

        assertNull("A 401 must remove the unusable token", sessionManager.token)
        assertNull("A 401 must remove the stale authenticated user", sessionManager.currentUser)
    }

    private fun authenticatedSessionManager(): SessionManager {
        val constructor = SessionManager::class.java.declaredConstructors.single { candidate ->
            candidate.parameterTypes.contentEquals(
                arrayOf(SharedPreferences::class.java, Boolean::class.javaPrimitiveType)
            )
        }
        constructor.isAccessible = true
        val sessionManager = constructor.newInstance(InMemorySharedPreferences(), false) as SessionManager
        sessionManager.commitVerifiedServerEndpoint(
            sessionManager.validateServerEndpoint("https://chat.example").getOrThrow()
        )
        sessionManager.saveAuthSuccess(
            User(id = 1, username = "alice", fullName = "Alice"),
            "stale-token"
        )
        return sessionManager
    }

    private fun unauthorizedResponseClient(): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(401)
                .message("Unauthorized")
                .body("{\"error\":\"Необходима авторизация\"}".toResponseBody())
                .build()
        }
        .build()

    private class InMemorySharedPreferences : SharedPreferences {
        private val values = mutableMapOf<String, Any?>()

        override fun getAll(): MutableMap<String, *> = values
        override fun getString(key: String, defValue: String?): String? = values[key] as? String ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = defValues
        override fun getInt(key: String, defValue: Int): Int = defValue
        override fun getLong(key: String, defValue: Long): Long = defValue
        override fun getFloat(key: String, defValue: Float): Float = defValue
        override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
        override fun contains(key: String): Boolean = values.containsKey(key)
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            override fun putString(key: String, value: String?): SharedPreferences.Editor = apply { values[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = this
            override fun putInt(key: String, value: Int): SharedPreferences.Editor = this
            override fun putLong(key: String, value: Long): SharedPreferences.Editor = this
            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = this
            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = apply { this@InMemorySharedPreferences.values[key] = value }
            override fun remove(key: String): SharedPreferences.Editor = apply { values.remove(key) }
            override fun clear(): SharedPreferences.Editor = apply { values.clear() }
            override fun commit(): Boolean = true
            override fun apply() = Unit
        }
    }
}