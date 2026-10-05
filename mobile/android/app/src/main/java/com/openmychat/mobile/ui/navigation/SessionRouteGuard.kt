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

    /**
     * Applies the session policy before a destination is rendered or added to a saved back stack.
     * This deliberately duplicates no asynchronous activity-level observer: process restoration
     * must be safe during the very first composition too.
     */
    fun destinationForNavigation(
        requestedDestination: NavKey,
        session: AuthenticatedRouteState
    ): NavKey = if (requestedDestination.requiresAuthenticatedSession() && !hasAuthenticatedSession(session)) {
        NavKey.Login
    } else {
        requestedDestination
    }

    fun destinationAfterSessionLoss(
        currentDestination: NavKey,
        session: AuthenticatedRouteState
    ): NavKey? {
        if (hasAuthenticatedSession(session) || !currentDestination.requiresAuthenticatedSession()) {
            return null
        }
        return destinationForNavigation(
            requestedDestination = currentDestination,
            session = session
        )
    }

    fun acceptsIncomingCall(session: AuthenticatedRouteState): Boolean =
        hasAuthenticatedSession(session)

    private fun NavKey.requiresAuthenticatedSession(): Boolean = when (this) {
        is NavKey.Conversations,
        is NavKey.Chat,
        is NavKey.People,
        is NavKey.Person,
        is NavKey.Announcements,
        is NavKey.Call,
        is NavKey.Profile,
        is NavKey.BlockedUsers,
        is NavKey.DeleteAccount -> true
        is NavKey.Login,
        is NavKey.Register,
        is NavKey.AccountStatus -> false
    }
}
