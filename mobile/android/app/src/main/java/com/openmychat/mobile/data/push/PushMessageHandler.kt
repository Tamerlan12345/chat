package com.openmychat.mobile.data.push

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.notifications.MessageNotifier
import com.openmychat.mobile.data.notifications.PushPayload
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeout
import javax.inject.Inject
import javax.inject.Singleton

/**
 * An FCM data message (push.md §4–5). The payload carries ids only; anything else in it is ignored.
 * A new message is fetched from our server with the session's token and shown by the app with its
 * sender and text; no session or no answer — the generic «Новое сообщение»; deleted meanwhile —
 * nothing. `read` dismisses the chat's notification; `call` shows an incoming-call notice that opens
 * the app (the socket then receives the same `call_offer`).
 */
@Singleton
class PushMessageHandler @Inject constructor(
    private val notifier: MessageNotifier,
    private val api: ApiClient
) {
    suspend fun handle(data: Map<String, String>) {
        when (val payload = PushPayload.parse(data)) {
            is PushPayload.Read -> notifier.onPush(data)
            is PushPayload.NewMessage -> {
                if (!notifier.wantsPush(payload)) return
                val fetched = try {
                    Fetched.Found(withTimeout(FETCH_TIMEOUT_MS) { fetch(payload) })
                } catch (e: CancellationException) {
                    // A timeout is not a deletion: say only that something arrived.
                    if (e is kotlinx.coroutines.TimeoutCancellationException) Fetched.Unknown else throw e
                } catch (_: ApiException) {
                    Fetched.Unknown
                } catch (_: Exception) {
                    Fetched.Unknown
                }
                when (fetched) {
                    is Fetched.Found -> fetched.message?.let { notifier.showPushed(payload, it) }
                    Fetched.Unknown -> notifier.showPushed(payload, null)
                }
            }
            is PushPayload.Call -> {
                val name = try {
                    withTimeout(FETCH_TIMEOUT_MS) { api.getUser(payload.callerId).fullName }
                } catch (e: CancellationException) {
                    if (e is kotlinx.coroutines.TimeoutCancellationException) null else throw e
                } catch (_: Exception) {
                    null
                }
                notifier.showIncomingCall(payload.callerId, name)
            }
            null -> Unit
        }
    }

    private sealed interface Fetched {
        /** [message] null: the server no longer has it (deleted). */
        class Found(val message: Message?) : Fetched
        data object Unknown : Fetched
    }

    /** The pushed message from our server: `afterId = messageId − 1`, the first one back. */
    private suspend fun fetch(payload: PushPayload.NewMessage): Message? {
        val conversation = payload.conversation
        val page = when (conversation.type) {
            ConversationType.DIRECT -> api.getDirectMessages(conversation.targetId, limit = 1, afterId = payload.messageId - 1)
            ConversationType.CHANNEL -> api.getChannelMessages(conversation.targetId, limit = 1, afterId = payload.messageId - 1)
        }
        return page.firstOrNull { it.id == payload.messageId && !it.isDeleted }
    }

    private companion object {
        const val FETCH_TIMEOUT_MS = 10_000L
    }
}
