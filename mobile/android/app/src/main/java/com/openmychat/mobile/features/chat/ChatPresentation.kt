package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.util.DateTimeUtils
import com.openmychat.mobile.data.model.DeliveryStatus
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.ui.components.BubblePosition
import com.openmychat.mobile.ui.components.DeliveryMark
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** What the list does when messages are appended. */
data class FollowDecision(val scrollToEnd: Boolean, val unseen: Int)

/**
 * Auto-scroll rule: follow new messages only when the reader is already at the bottom; otherwise
 * keep their place and count the new ones for a «↓ N новых» pill. Sending always jumps to the new
 * own bubble.
 */
object FollowPolicy {
    fun onAppended(atBottom: Boolean, ownAppended: Boolean, incomingAppended: Int, unseen: Int): FollowDecision = when {
        ownAppended || atBottom -> FollowDecision(scrollToEnd = true, unseen = 0)
        else -> FollowDecision(scrollToEnd = false, unseen = unseen + incomingAppended)
    }

    /**
     * Messages after [previousLastId]. Nothing counts as appended on the first load (null) or when
     * the previous last message is gone (deleted): then nothing is guessed as new.
     */
    fun appendedSince(previousLastId: Long?, messages: List<Message>): List<Message> {
        if (previousLastId == null) return emptyList()
        val index = messages.indexOfLast { it.id == previousLastId }
        if (index < 0) return emptyList()
        return messages.subList(index + 1, messages.size)
    }
}

/** Rows of the message list: date separators and bubbles, with stable keys for animateItem(). */
sealed interface ChatItem {
    val key: String

    /** The day this row belongs to (the sticky date pill shows it). */
    val day: LocalDate

    data class Day(override val day: LocalDate) : ChatItem {
        override val key: String get() = "day-$day"
    }

    data class Bubble(
        val message: Message,
        val isOwn: Boolean,
        /** Place in a run from one sender: drives the radii (the tail is on the first only). */
        val position: BubblePosition,
        val mark: DeliveryMark?,
        /**
         * Time and state are shown on the last bubble of a group; an earlier bubble shows them only
         * when it is edited. Stable inputs only: a delivery status catching up never reflows history.
         */
        val showsMeta: Boolean,
        override val day: LocalDate
    ) : ChatItem {
        override val key: String get() = "msg-${message.id}"

        /** First of a run from one sender: carries the tail corner and, in channels, the name. */
        val startsGroup: Boolean get() = position.startsGroup
    }

    /** The peer is typing: a bubble with the dots wave at the newest end of the list. */
    data object Typing : ChatItem {
        override val key: String get() = "typing"
        override val day: LocalDate get() = LocalDate.MAX
    }
}

/** Desktop ChatView: a new group after 5 minutes, another sender or another day. */
const val GROUP_BREAK_MILLIS = 5 * 60 * 1000L

/**
 * Chronological rows (oldest first). [markOverride] lets the send queue (Task 15) report queued,
 * sending and failed states for own messages; without it the server status decides.
 */
fun buildChatItems(
    messages: List<Message>,
    currentUserId: Long,
    zone: ZoneId = ZoneId.systemDefault(),
    markOverride: (Message) -> DeliveryMark? = { null }
): List<ChatItem> {
    val n = messages.size
    if (n == 0) return emptyList()
    val millis = LongArray(n) { DateTimeUtils.parseIso8601ToMillis(messages[it].createdAt) }
    val days = Array<LocalDate>(n) { Instant.ofEpochMilli(millis[it]).atZone(zone).toLocalDate() }
    val starts = BooleanArray(n) { i ->
        i == 0 || days[i] != days[i - 1] || messages[i].senderId != messages[i - 1].senderId ||
            millis[i] - millis[i - 1] > GROUP_BREAK_MILLIS
    }
    val marks = Array(n) { i -> markOverride(messages[i]) ?: deliveryMark(messages[i], messages[i].senderId == currentUserId) }
    // Index of the last bubble of each message's group, filled from the end.
    val groupEnd = IntArray(n)
    for (i in n - 1 downTo 0) groupEnd[i] = if (i == n - 1 || starts[i + 1]) i else groupEnd[i + 1]

    val items = ArrayList<ChatItem>(n + 4)
    messages.forEachIndexed { i, message ->
        if (i == 0 || days[i] != days[i - 1]) items += ChatItem.Day(days[i])
        val ends = groupEnd[i] == i
        val position = when {
            starts[i] && ends -> BubblePosition.SINGLE
            starts[i] -> BubblePosition.FIRST
            ends -> BubblePosition.LAST
            else -> BubblePosition.MIDDLE
        }
        val edited = !message.updatedAt.isNullOrBlank() && !message.isDeleted
        items += ChatItem.Bubble(
            message = message,
            isOwn = message.senderId == currentUserId,
            position = position,
            mark = marks[i],
            showsMeta = ends || edited,
            day = days[i]
        )
    }
    return items
}

/**
 * A message in the list is already stored on the server, so without a delivery status it is
 * "sent" (✓). Delivered ✓✓ and read ✓✓ (accent) come from the server. Incoming messages show none.
 */
fun deliveryMark(message: Message, isOwn: Boolean): DeliveryMark? {
    if (!isOwn) return null
    return when (message.deliveryStatus) {
        DeliveryStatus.READ -> DeliveryMark.READ
        DeliveryStatus.DELIVERED -> DeliveryMark.DELIVERED
        null -> DeliveryMark.SENT
    }
}
