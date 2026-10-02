package com.openmychat.mobile.core.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerEndpointPolicyTest {

    @Test
    fun httpsEndpointIsNormalizedAndDerivesWssUrl() {
        val endpoint = ServerEndpointPolicy.validate("https://chat.example/", allowInsecureDebug = false).getOrThrow()

        assertEquals("https://chat.example/api", endpoint.apiBaseUrl)
        assertEquals("wss://chat.example/ws", endpoint.webSocketUrl)
        assertTrue(endpoint.isSecure)
    }

    @Test
    fun releaseRejectsInsecureAndUnsupportedSchemes() {
        assertTrue(ServerEndpointPolicy.validate("http://10.0.2.2:2004/api", allowInsecureDebug = false).isFailure)
        assertTrue(ServerEndpointPolicy.validate("ftp://chat.example/api", allowInsecureDebug = false).isFailure)
    }

    @Test
    fun debugAllowsOnlyExplicitLocalEmulatorHttpEndpoint() {
        val endpoint = ServerEndpointPolicy.validate("http://10.0.2.2:2004", allowInsecureDebug = true).getOrThrow()

        assertEquals("http://10.0.2.2:2004/api", endpoint.apiBaseUrl)
        assertEquals("ws://10.0.2.2:2004/ws", endpoint.webSocketUrl)
        assertFalse(endpoint.isSecure)
        assertTrue(ServerEndpointPolicy.validate("http://chat.example/api", allowInsecureDebug = true).isFailure)
        assertTrue(ServerEndpointPolicy.validate("http://10.0.2.3:2004/api", allowInsecureDebug = true).isFailure)
        assertTrue(ServerEndpointPolicy.validate("http://192.168.1.20:2004/api", allowInsecureDebug = true).isFailure)
    }

    @Test
    fun invalidServerUrlUsesTheRussianOnboardingMessage() {
        val failure = ServerEndpointPolicy.validate("ftp", allowInsecureDebug = false).exceptionOrNull()

        assertEquals("Введите корректный адрес сервера", failure?.message)
    }
}
