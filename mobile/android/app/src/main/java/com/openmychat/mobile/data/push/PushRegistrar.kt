package com.openmychat.mobile.data.push

import com.openmychat.mobile.BuildConfig
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.di.ApplicationScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/** The device's push token from the provider (FCM); null when push is not configured in this build. */
interface PushTokenSource {
    suspend fun currentToken(): String?

    /**
     * Explicit sign-out: the provider forgets this device's token, so the old session's pushes stop
     * even if `/auth/logout` never reached the server (review fix round 1). Nothing to do without push.
     */
    suspend fun delete() = Unit
}

/**
 * Registers this device's FCM token with the server (`POST /api/devices/push-token`, push.md §2) for
 * the account signed in: after every sign-in, at every start with a live session, and whenever the
 * provider rotates the token. Signing out needs no call here: `/auth/logout` with `device_id` removes
 * this device's tokens on the server. Without Firebase configuration (no google-services.json in the
 * build, decision P) there is no token and nothing is sent.
 */
@Singleton
class PushRegistrar @Inject constructor(
    private val tokens: PushTokenSource,
    private val api: ApiClient,
    private val session: SessionManager,
    @ApplicationScope private val scope: CoroutineScope
) {
    private var started = false

    @Synchronized
    fun start() {
        if (started) return
        started = true
        scope.launch {
            session.currentUserFlow.map { it?.id }.distinctUntilChanged().collect { account ->
                if (account != null) tokens.currentToken()?.let { register(it, account) }
            }
        }
    }

    /** FCM `onNewToken`: the new token goes to the server for the account signed in now, if any. */
    fun onNewToken(token: String) {
        scope.launch {
            val account = session.currentUser?.id ?: return@launch
            register(token, account)
        }
    }

    private suspend fun register(token: String, account: Long) {
        try {
            // The request is bound to the session of the moment it is made (ApiClient); a sign-in
            // of another account meanwhile registers again for that one.
            if (session.currentUser?.id != account) return
            send(token)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Best effort: the next start, sign-in or token rotation registers it again.
        }
    }

    private suspend fun send(token: String) {
        api.registerPushToken(
            token = token,
            deviceId = runCatching { session.deviceId }.getOrNull(),
            appVersion = BuildConfig.VERSION_NAME
        )
    }
}
