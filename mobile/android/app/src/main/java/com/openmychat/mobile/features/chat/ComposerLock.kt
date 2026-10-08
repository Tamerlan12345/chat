package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.delivery.DeliveryState
import com.openmychat.mobile.data.delivery.OutboxEntry
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.SendState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Why the composer of a direct chat is closed. */
enum class ComposerLock {
    NONE,

    /** I blocked this person: nothing goes either way until I unblock. */
    BLOCKED_BY_ME,

    /** The server refused a send with `DM_NOT_ALLOWED` (the other side blocked me, or I them elsewhere). */
    NOT_DELIVERABLE
}

/** Отказ сервера в доставке личного сообщения (блокировка с любой стороны), contracts/registration.md §4. */
internal const val DM_NOT_ALLOWED = "DM_NOT_ALLOWED"

/**
 * The server's `DM_NOT_ALLOWED` in one direct chat ([conversation] with [peer]): a refused send closes
 * the composer ([closed]); seeing delivery work again — a successful history load or a newer message
 * from the peer (they may have unblocked me) — reopens it ([reopen]). A send refused after that closes
 * it again.
 */
internal class RefusedDelivery(private val conversation: String, private val peer: Long) {
    private val _closed = MutableStateFlow(false)
    val closed: StateFlow<Boolean> = _closed.asStateFlow()

    /** Refusals the chat no longer stays closed for: delivery was seen to work after them. */
    private val reopenedAfter = HashSet<String>()

    /** The newest message from the peer seen so far. */
    private var newestPeerMessage: Long? = null

    /** The model changed: [shown] is this chat's projected history. */
    fun observe(state: DeliveryState, shown: List<Message>) {
        val peerNewest = shown.asSequence().filter { it.senderId == peer && it.sendState == SendState.SENT }.maxOfOrNull { it.id }
        val seen = newestPeerMessage
        if (peerNewest != null && seen != null && peerNewest > seen) reopen(state)
        if (peerNewest != null && (seen == null || peerNewest > seen)) newestPeerMessage = peerNewest
        if (refusals(state).any { it !in reopenedAfter }) _closed.value = true
    }

    /** Delivery works again (or I unblocked the peer): the refusals so far no longer close the chat. */
    fun reopen(state: DeliveryState?) {
        state?.let { reopenedAfter += refusals(it) }
        _closed.value = false
    }

    /** Client keys of this chat's sends the server refused with `DM_NOT_ALLOWED`. */
    private fun refusals(state: DeliveryState): List<String> = state.outbox
        .filter { it.conversation == conversation && it.state == OutboxEntry.FAILED && it.failure?.code == DM_NOT_ALLOWED }
        .map { it.clientMsgId }
}
