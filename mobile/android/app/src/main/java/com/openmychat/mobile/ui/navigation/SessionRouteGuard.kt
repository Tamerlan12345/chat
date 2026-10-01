package com.openmychat.mobile.ui.navigation

import com.openmychat.mobile.core.session.SessionStorageState

data class AuthenticatedRouteState(
    val token: String?,
    val hasCurrentUser: Boolean,
    val storageState: SessionStorageState
)

/** Keeps protected routes and call navigation closed once local session state is no longer valid. */
object SessionRouteGuard {
    fun hasAuthenticatedSession(session: AuthenticatedRouteState): Boolean =
        session.storageState == SessionStorageState.AVAILABLE &&
            !session.token.isNullOrBlank() &&
            session.hasCurrentUser

    fun destinationAfterSessionLoss(
        currentDestination: NavKey,
        session: AuthenticatedRouteState,
        hasConfiguredServer: Boolean
    ): NavKey? {
        if (hasAuthenticatedSession(session) || !currentDestination.requiresAuthenticatedSession()) {
            return null
        }
        return if (hasConfiguredServer) NavKey.Login else NavKey.ServerConnect
    }

    fun acceptsIncomingCall(session: AuthenticatedRouteState): Boolean =
        hasAuthenticatedSession(session)

    private fun NavKey.requiresAuthenticatedSession(): Boolean = when (this) {
        is NavKey.Conversations,
        is NavKey.Chat,
        is NavKey.Announcements,
        is NavKey.Call,
        is NavKey.Profile -> true
        is NavKey.Login,
        is NavKey.ServerConnect -> false
    }
}
