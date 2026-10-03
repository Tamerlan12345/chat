package com.openmychat.mobile.core.config

import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.repository.AuthRepository
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.ui.navigation.NavKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.lang.reflect.Modifier

class ServerConfigTest {

    @Test
    fun productionServerIsTheRailwayDeployment() {
        assertEquals("https://centychat-production.up.railway.app", ServerConfig.PRODUCTION_SERVER_URL)
    }

    @Test
    fun releaseBuildsResolveExactlyTheProductionServerWhateverTheBuildConfigSays() {
        listOf("https://attacker.example", "https://10.0.2.2:8443", "", "not a url").forEach { configured ->
            val endpoint = ServerConfig.resolve(isDebugBuild = false, configuredUrl = configured)

            assertEquals("https://centychat-production.up.railway.app/api", endpoint.apiBaseUrl)
            assertEquals("wss://centychat-production.up.railway.app/ws", endpoint.webSocketUrl)
            assertTrue(endpoint.isSecure)
        }
    }

    @Test
    fun debugBuildsUseTheServerFromTheBuildConfiguration() {
        val endpoint = ServerConfig.resolve(isDebugBuild = true, configuredUrl = "https://10.0.2.2:8443")

        assertEquals("https://10.0.2.2:8443/api", endpoint.apiBaseUrl)
        assertEquals("wss://10.0.2.2:8443/ws", endpoint.webSocketUrl)
    }

    @Test
    fun debugBuildsStillRefusePlainHttpToAPublicHost() {
        try {
            ServerConfig.resolve(isDebugBuild = true, configuredUrl = "http://chat.example.com")
            fail("a debug build must not talk plain HTTP to a public host")
        } catch (_: IllegalStateException) {
            // Expected: a misconfigured build fails at start instead of leaking credentials.
        }
    }

    /**
     * Nothing at runtime may choose the server: no setter, no "connect to server" call, no setup
     * destination. A deep link, intent extra or stored value has nothing to feed into.
     */
    @Test
    fun noRuntimePathCanChangeTheServer() {
        val forbidden = setOf(
            "setServerUrl",
            "commitVerifiedServerEndpoint",
            "useServerEndpointForVerification",
            "restorePersistedServerEndpoint",
            "validateServerEndpoint",
            "connect"
        )
        listOf(SessionManager::class.java, AuthRepository::class.java, SessionRepository::class.java).forEach { type ->
            val present = type.methods.map { it.name }.filter { it in forbidden }
            assertEquals("${type.simpleName} exposes a server override", emptyList<String>(), present)
        }
        assertEquals(
            "a server-setup destination still exists",
            emptyList<String>(),
            NavKey::class.java.declaredClasses.map { it.simpleName }.filter { it.contains("Server") }
        )
        val mutable = ServerConfig::class.java.declaredFields.filter { field ->
            !Modifier.isStatic(field.modifiers) || !Modifier.isFinal(field.modifiers)
        }
        assertEquals("ServerConfig must hold no mutable state", emptyList<String>(), mutable.map { it.name })
    }
}
