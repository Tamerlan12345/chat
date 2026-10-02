package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.core.session.SessionStorageState
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.ui.navigation.AuthenticatedRouteState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import javax.inject.Inject
import javax.inject.Singleton

/** Read-only view of the local authenticated session for ViewModels and navigation. */
interface SessionRepository {
    val token: StateFlow<String?>
    val currentUser: StateFlow<User?>
    val storageState: StateFlow<SessionStorageState>
    val mustChangePassword: StateFlow<Boolean>

    /** Emits whenever any part of the session that gates protected routes changes. */
    val routeStates: Flow<AuthenticatedRouteState>

    val currentUserId: Long?
    val isAdmin: Boolean
    val messageEditWindowMinutes: String
    val messageDeleteWindowMinutes: String

    /** Synchronous snapshot, used where a decision must not wait for a flow emission. */
    fun routeState(): AuthenticatedRouteState
}

@Singleton
class DefaultSessionRepository @Inject constructor(
    private val sessionManager: SessionManager
) : SessionRepository {
    override val token: StateFlow<String?> get() = sessionManager.tokenFlow
    override val currentUser: StateFlow<User?> get() = sessionManager.currentUserFlow
    override val storageState: StateFlow<SessionStorageState> get() = sessionManager.storageState
    override val mustChangePassword: StateFlow<Boolean> get() = sessionManager.mustChangePasswordFlow

    override val routeStates: Flow<AuthenticatedRouteState> = combine(
        sessionManager.tokenFlow,
        sessionManager.currentUserFlow,
        sessionManager.storageState
    ) { token, user, storageState ->
        AuthenticatedRouteState(token, user != null, storageState)
    }

    override val currentUserId: Long? get() = sessionManager.currentUser?.id
    override val isAdmin: Boolean get() = sessionManager.currentUser?.permissions?.isAdmin == true
    override val messageEditWindowMinutes: String get() = sessionManager.messageEditWindowMinutes
    override val messageDeleteWindowMinutes: String get() = sessionManager.messageDeleteWindowMinutes

    override fun routeState(): AuthenticatedRouteState = AuthenticatedRouteState(
        token = sessionManager.token,
        hasCurrentUser = sessionManager.currentUser != null,
        storageState = sessionManager.storageState.value
    )
}
