package com.openmychat.mobile.core.network

import android.content.SharedPreferences
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.core.session.SessionStorageState
import com.openmychat.mobile.data.model.ChangePasswordRequest
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import com.openmychat.mobile.testing.TestSessions

class ApiClientSecureStorageFailureTest {

    @Test
    fun refreshSurfacesStorageFailureInsteadOfReturningAnUnpersistedToken() = runBlocking {
        val sessionManager = sessionManagerWhoseNextWriteFails()
        val apiClient = ApiClient(sessionManager, refreshResponseClient())

        try {
            apiClient.refreshToken()
            fail("refresh must fail when the replacement token cannot be persisted securely")
        } catch (_: SecureStorageUnavailableException) {
            // Expected: callers can keep the user unauthenticated and ask them to recover device security.
        }

        assertEquals(SessionStorageState.UNAVAILABLE, sessionManager.storageState.value)
        assertNull(sessionManager.token)
        assertNull(sessionManager.currentUser)
    }

    @Test
    fun passwordChangeSurfacesStorageFailureInsteadOfReportingSuccessfulAuthentication() = runBlocking {
        val sessionManager = sessionManagerWhoseNextWriteFails()
        val apiClient = ApiClient(sessionManager, passwordChangeResponseClient())

        try {
            apiClient.changePassword(ChangePasswordRequest(oldPassword = "old-pass", newPassword = "new-pass"))
            fail("password change must fail when its new token cannot be persisted securely")
        } catch (_: SecureStorageUnavailableException) {
            // Expected: a successful server response is not an authenticated local session.
        }

        assertEquals(SessionStorageState.UNAVAILABLE, sessionManager.storageState.value)
        assertNull(sessionManager.token)
        assertNull(sessionManager.currentUser)
    }

    private fun sessionManagerWhoseNextWriteFails(): SessionManager = SessionManager(
        prefs = FailingCommitSharedPreferences(),
        serverEndpoint = TestSessions.CHAT_EXAMPLE
    )

    private fun refreshResponseClient(): OkHttpClient = responseClient {
        """{"user":{"id":1,"username":"alice","full_name":"Alice"},"token":"replacement-token"}"""
    }

    private fun passwordChangeResponseClient(): OkHttpClient = responseClient {
        """{"success":true,"token":"replacement-token","user":{"id":1,"username":"alice","full_name":"Alice"}}"""
    }

    private fun responseClient(body: () -> String): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(body().toResponseBody())
                .build()
        }
        .build()

    private class FailingCommitSharedPreferences : SharedPreferences {
        private val initialValues = mapOf(
            "jwt_token" to "old-token",
            "server_url" to "https://chat.example/api"
        )

        override fun getAll(): MutableMap<String, *> = initialValues.toMutableMap()
        override fun getString(key: String, defValue: String?): String? = initialValues[key] as? String ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = defValues
        override fun getInt(key: String, defValue: Int): Int = defValue
        override fun getLong(key: String, defValue: Long): Long = defValue
        override fun getFloat(key: String, defValue: Float): Float = defValue
        override fun getBoolean(key: String, defValue: Boolean): Boolean = defValue
        override fun contains(key: String): Boolean = initialValues.containsKey(key)
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            override fun putString(key: String, value: String?): SharedPreferences.Editor = this
            override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = this
            override fun putInt(key: String, value: Int): SharedPreferences.Editor = this
            override fun putLong(key: String, value: Long): SharedPreferences.Editor = this
            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = this
            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = this
            override fun remove(key: String): SharedPreferences.Editor = this
            override fun clear(): SharedPreferences.Editor = this
            override fun commit(): Boolean = false
            override fun apply() = Unit
        }
    }
}
