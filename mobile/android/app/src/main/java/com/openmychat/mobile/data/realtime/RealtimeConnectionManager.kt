package com.openmychat.mobile.data.realtime

import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.di.ApplicationScope
import com.openmychat.mobile.ui.navigation.SessionRouteGuard
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Keeps the WebSocket connected exactly while an authenticated session exists. Runs in the
 * application scope so configuration changes do not tear the socket down.
 */
@Singleton
class RealtimeConnectionManager @Inject constructor(
    private val sessionRepository: SessionRepository,
    private val webSocketClient: WebSocketClient,
    @ApplicationScope private val scope: CoroutineScope
) {
    private var job: Job? = null

    @Synchronized
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            sessionRepository.routeStates.collectLatest { session ->
                if (SessionRouteGuard.hasAuthenticatedSession(session)) {
                    webSocketClient.connect(scope)
                } else {
                    webSocketClient.disconnect()
                }
            }
        }
    }

    @Synchronized
    fun stop() {
        job?.cancel()
        job = null
        webSocketClient.disconnect()
    }
}
