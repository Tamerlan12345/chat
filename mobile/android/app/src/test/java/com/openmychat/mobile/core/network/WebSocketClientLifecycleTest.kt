package com.openmychat.mobile.core.network

import android.content.SharedPreferences
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.User
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Test
import com.openmychat.mobile.testing.TestSessions
import java.util.concurrent.atomic.AtomicInteger

class WebSocketClientLifecycleTest {

    @Test
    fun connectDoesNotOpenDuplicateSocketWhileFirstConnectionIsPending() {
        val sessionManager = sessionManagerWithAuthenticatedServer()
        val openedSockets = AtomicInteger(0)
        val client = WebSocketClient(
            sessionManager = sessionManager,
            webSocketFactory = { _, _ ->
                openedSockets.incrementAndGet()
                FakeWebSocket
            }
        )
        val scope = CoroutineScope(SupervisorJob())

        client.connect(scope)
        client.connect(scope)

        assertEquals("The initial tokenFlow emission must not create a second socket", 1, openedSockets.get())
        client.disconnect()
    }

    private fun sessionManagerWithAuthenticatedServer(): SessionManager {
        val constructor = SessionManager::class.java.declaredConstructors.single { candidate ->
            candidate.parameterTypes.contentEquals(
                arrayOf(SharedPreferences::class.java, ValidatedEndpoint::class.java)
            )
        }
        constructor.isAccessible = true
        val sessionManager = constructor.newInstance(AvailableSharedPreferences(), TestSessions.CHAT_EXAMPLE) as SessionManager
        sessionManager.saveAuthSuccess(User(id = 1, username = "alice", fullName = "Alice"), "token")
        return sessionManager
    }

    private object FakeWebSocket : WebSocket {
        override fun request(): Request = Request.Builder().url("https://chat.example/ws").build()
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean = true
        override fun send(bytes: ByteString): Boolean = true
        override fun close(code: Int, reason: String?): Boolean = true
        override fun cancel() = Unit
    }

    private class AvailableSharedPreferences : SharedPreferences {
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
            override fun putString(key: String, value: String?): SharedPreferences.Editor {
                values[key] = value
                return this
            }
            override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = this
            override fun putInt(key: String, value: Int): SharedPreferences.Editor = this
            override fun putLong(key: String, value: Long): SharedPreferences.Editor = this
            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = this
            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor {
                values[key] = value
                return this
            }
            override fun remove(key: String): SharedPreferences.Editor {
                values.remove(key)
                return this
            }
            override fun clear(): SharedPreferences.Editor {
                values.clear()
                return this
            }
            override fun commit(): Boolean = true
            override fun apply() = Unit
        }
    }
}
