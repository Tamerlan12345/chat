package com.openmychat.mobile.ui.navigation

import com.openmychat.mobile.core.session.SessionStorageState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionRouteGuardTest {

    @Test
    fun unavailableSecureStorageRevokesProtectedRouteAndDropsIncomingCall() {
        val revokedSession = AuthenticatedRouteState(
            token = "token",
            hasCurrentUser = true,
            storageState = SessionStorageState.UNAVAILABLE
        )

        assertFalse(SessionRouteGuard.hasAuthenticatedSession(revokedSession))
        assertEquals(
            NavKey.Login,
            SessionRouteGuard.destinationAfterSessionLoss(
                currentDestination = NavKey.Conversations,
                session = revokedSession,
                hasConfiguredServer = true
            )
        )
        assertFalse(SessionRouteGuard.acceptsIncomingCall(revokedSession))
    }

    @Test
    fun authenticatedSessionKeepsProtectedRouteAndAcceptsIncomingCall() {
        val activeSession = AuthenticatedRouteState(
            token = "token",
            hasCurrentUser = true,
            storageState = SessionStorageState.AVAILABLE
        )

        assertTrue(SessionRouteGuard.hasAuthenticatedSession(activeSession))
        assertEquals(
            null,
            SessionRouteGuard.destinationAfterSessionLoss(
                currentDestination = NavKey.Chat("direct", 42, "Alice"),
                session = activeSession,
                hasConfiguredServer = true
            )
        )
        assertTrue(SessionRouteGuard.acceptsIncomingCall(activeSession))
    }

    @Test
    fun unavailableSessionRedirectsRestoredCallRouteBeforeItCanRender() {
        val unavailableSession = AuthenticatedRouteState(
            token = "stale-token",
            hasCurrentUser = true,
            storageState = SessionStorageState.UNAVAILABLE
        )

        assertEquals(
            NavKey.Login,
            SessionRouteGuard.destinationForNavigation(
                requestedDestination = NavKey.Call(peerId = 42, peerName = "Alice"),
                session = unavailableSession,
                hasConfiguredServer = true
            )
        )
    }
}
