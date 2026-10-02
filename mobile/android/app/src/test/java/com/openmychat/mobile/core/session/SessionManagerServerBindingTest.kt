package com.openmychat.mobile.core.session

import com.openmychat.mobile.core.config.ServerConfig
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.testing.InMemorySharedPreferences
import com.openmychat.mobile.ui.navigation.AuthenticatedRouteState
import com.openmychat.mobile.ui.navigation.SessionRouteGuard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Older installs let the user type a server address and kept it, with the session, in the secure
 * store. The server is now fixed at build time: a stored address must never choose the endpoint,
 * and credentials issued by any other server must be wiped so the user lands on the login screen.
 */
class SessionManagerServerBindingTest {

    private val production = ServerConfig.resolve(isDebugBuild = false, configuredUrl = "")
    private val devStand = ServerConfig.resolve(isDebugBuild = true, configuredUrl = "https://10.0.2.2:8443")

    @Test
    fun aSessionIssuedByAnotherServerIsWipedAndTheUserLandsOnLogin() {
        val prefs = legacyInstall(serverUrl = "https://old-corp.example/api")

        val manager = SessionManager(prefs, production)

        assertNull(manager.token)
        assertNull(manager.currentUser)
        assertNull(manager.deviceSecret)
        assertFalse(SessionRouteGuard.hasAuthenticatedSession(routeState(manager)))
        assertEquals("the device id is not a credential and survives", "device-1", manager.deviceId)
        assertEquals("https://centychat-production.up.railway.app/api", manager.serverUrl)
        // The wipe is durable, not just an in-memory view.
        assertNull(prefs.getString("jwt_token", null))
        assertNull(prefs.getString("device_secret", null))
        assertNull(SessionManager(prefs, production).token)
    }

    @Test
    fun aStoredCustomServerAddressNeverChoosesTheEndpoint() {
        val prefs = InMemorySharedPreferences().apply {
            edit().putString("server_url", "https://evil.example/api").commit()
        }

        val manager = SessionManager(prefs, production)

        assertEquals("https://centychat-production.up.railway.app/api", manager.serverUrl)
        assertEquals("https://centychat-production.up.railway.app/api", manager.serverEndpoint.apiBaseUrl)
        assertEquals("wss://centychat-production.up.railway.app/ws", manager.serverEndpoint.webSocketUrl)
    }

    @Test
    fun aLegacySessionAlreadyOnTheProductionServerIsKept() {
        val prefs = legacyInstall(serverUrl = "https://centychat-production.up.railway.app/api")

        val manager = SessionManager(prefs, production)

        assertEquals("legacy-token", manager.token)
        assertEquals("alice", manager.currentUser?.username)
        assertEquals("legacy-secret", manager.deviceSecret)
    }

    @Test
    fun aSessionWithNoRecordOfItsServerIsWiped() {
        val prefs = legacyInstall(serverUrl = null)

        val manager = SessionManager(prefs, production)

        assertNull(manager.token)
        assertNull(manager.currentUser)
        assertNull(manager.deviceSecret)
    }

    @Test
    fun newSessionsStayBoundToTheServerThatIssuedThem() {
        val prefs = InMemorySharedPreferences()
        SessionManager(prefs, production).saveAuthSuccess(User(id = 1, username = "alice", fullName = "Alice"), "prod-token")

        assertEquals("prod-token", SessionManager(prefs, production).token)
        // A debug build pointed at the dev stand must never send the production token there.
        assertNull(SessionManager(prefs, devStand).token)
    }

    private fun legacyInstall(serverUrl: String?): InMemorySharedPreferences = InMemorySharedPreferences().apply {
        val editor = edit()
        if (serverUrl != null) editor.putString("server_url", serverUrl)
        editor.putString("jwt_token", "legacy-token")
        editor.putString("current_user_json", """{"id":1,"username":"alice","full_name":"Alice"}""")
        editor.putString("device_secret", "legacy-secret")
        editor.putString("device_id", "device-1")
        editor.putBoolean("must_change_password", false)
        editor.commit()
    }

    private fun routeState(manager: SessionManager) = AuthenticatedRouteState(
        token = manager.token,
        hasCurrentUser = manager.currentUser != null,
        storageState = manager.storageState.value
    )
}
