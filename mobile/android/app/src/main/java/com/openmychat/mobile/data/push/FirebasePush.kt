package com.openmychat.mobile.data.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dagger.hilt.android.AndroidEntryPoint
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

/**
 * The FCM token, when this build has a Firebase configuration. Without `app/google-services.json`
 * the Google Services plugin is not applied, no FirebaseApp exists, and push is simply off
 * (decision P): this answers null and nothing is registered.
 */
@Singleton
class FirebasePushTokenSource @Inject constructor(
    @ApplicationContext private val context: Context
) : PushTokenSource {
    override suspend fun currentToken(): String? {
        if (!isConfigured(context)) return null
        return suspendCancellableCoroutine { continuation ->
            // getToken() is deprecated in firebase-messaging 25 in favour of register()/onRegistered;
            // it still returns the token, and onRegistered below takes the new path's token too.
            @Suppress("DEPRECATION")
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (continuation.isActive) continuation.resume(if (task.isSuccessful) task.result else null)
            }
        }
    }

    companion object {
        fun isConfigured(context: Context): Boolean = runCatching { FirebaseApp.getApps(context).isNotEmpty() }.getOrDefault(false)
    }
}

/**
 * FCM delivery (push.md §5). Runs only in builds with a Firebase configuration. Data messages
 * carry ids only; [PushMessageHandler] fetches the content from our server and shows it.
 */
@AndroidEntryPoint
class CentyMessagingService : FirebaseMessagingService() {
    @Inject lateinit var registrar: PushRegistrar
    @Inject lateinit var handler: PushMessageHandler

    @Deprecated("firebase-messaging 25: onRegistered is the new callback; both are handled")
    override fun onNewToken(token: String) {
        registrar.onNewToken(token)
    }

    override fun onRegistered(token: String) {
        registrar.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        // Already on a background thread, with about 20 s before the process may be frozen again:
        // the fetch inside is bounded by its own timeout.
        runBlocking { handler.handle(message.data) }
    }
}
