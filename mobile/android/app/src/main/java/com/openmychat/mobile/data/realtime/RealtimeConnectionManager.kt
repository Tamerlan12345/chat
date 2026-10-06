package com.openmychat.mobile.data.realtime

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.di.ApplicationScope
import com.openmychat.mobile.ui.navigation.SessionRouteGuard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/** Checks the stored session against the server (refreshing it, or clearing it on 401). */
fun interface SessionVerifier {
    suspend fun verify()
}

/**
 * Keeps the WebSocket connected exactly while an authenticated session exists. Runs in the
 * application scope so configuration changes do not tear the socket down.
 */
@Singleton
class RealtimeConnectionManager @Inject constructor(
    private val sessionRepository: SessionRepository,
    private val webSocketClient: WebSocketClient,
    @ApplicationScope private val scope: CoroutineScope,
    private val sessionVerifier: SessionVerifier
) {
    private var job: Job? = null

    /** The screen that started the link last; only it may stop it. */
    private var owner: Any? = null

    /**
     * Starts the link for [owner] (the activity's token). A newer owner takes over: an activity finished by
     * Back is destroyed only after the reopened one was created, and its stop must not end the link.
     */
    @Synchronized
    fun start(owner: Any) {
        this.owner = owner
        if (job?.isActive == true) return
        job = scope.launch {
            launch {
                sessionRepository.routeStates.collectLatest { session ->
                    if (SessionRouteGuard.hasAuthenticatedSession(session)) {
                        webSocketClient.connect(scope)
                    } else {
                        webSocketClient.disconnect()
                    }
                }
            }
            launch {
                // The socket stops on a refused token. Check it over HTTP once: a refreshed token
                // reconnects through routeStates above, a 401 clears the session and signs out.
                webSocketClient.connectionState.collect { state ->
                    if (state is ConnectionState.Unauthorized && state.code == "INVALID_TOKEN") {
                        try {
                            sessionVerifier.verify()
                        } catch (error: CancellationException) {
                            throw error
                        } catch (_: Exception) {
                            // Offline or server error: keep the session; the next session change retries.
                        }
                    }
                }
            }
        }
    }

    /** Ends the link when [owner] is the screen that started it last; a replaced screen's stop is ignored. */
    @Synchronized
    fun stop(owner: Any) {
        if (owner !== this.owner) return
        this.owner = null
        job?.cancel()
        job = null
        webSocketClient.disconnect()
    }
}
