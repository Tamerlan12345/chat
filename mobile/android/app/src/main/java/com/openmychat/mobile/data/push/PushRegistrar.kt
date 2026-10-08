package com.openmychat.mobile.data.push

import com.openmychat.mobile.BuildConfig
import com.openmychat.mobile.core.network.RequestOwner
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.di.ApplicationScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.atomic.AtomicLong
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
    private val registration = Mutex()
    private val tokenVersion = AtomicLong()

    @Synchronized
    fun start() {
        if (started) return
        started = true
        scope.launch {
            session.authenticatedSession.collectLatest { signedIn ->
                if (signedIn != null) bestEffort {
                    val version = tokenVersion.get()
                    tokens.currentToken()?.let { register(it, signedIn, version) }
                }
            }
        }
    }

    /** FCM callbacks are ordered at entry, before coroutine scheduling can reorder them. */
    fun onNewToken(token: String) {
        val version = tokenVersion.incrementAndGet()
        val signedIn = session.authenticatedSession.value ?: return
        scope.launch { bestEffort { register(token, signedIn, version) } }
    }

    private suspend fun register(
        token: String,
        signedIn: SessionManager.AuthenticatedSession,
        version: Long
    ) = registration.withLock {
        // Keep the lock until the HTTP call completes: an older request cannot land last.
        if (session.authenticatedSession.value != signedIn || tokenVersion.get() != version) return@withLock
        withContext(RequestOwner(signedIn.userId)) {
            // raw() binds credentials to this owner after IO dispatch, closing the account-switch
            // race between this check and constructing the actual HTTP request.
            api.raw("POST", "/api/devices/push-token", buildJsonObject {
                put("platform", "android")
                put("token", token)
                put("app_version", BuildConfig.VERSION_NAME)
                runCatching { session.deviceId }.getOrNull()?.let { put("device_id", it) }
            })
        }
    }

    private suspend fun bestEffort(action: suspend () -> Unit) {
        try {
            action()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Provider and network errors are retried on the next start, sign-in or token rotation.
        }
    }
}
