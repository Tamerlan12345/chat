package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.util.DateTimeUtils
import com.openmychat.mobile.data.model.DeliveryStatus
import com.openmychat.mobile.data.model.Message
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

/** Rows of the message list: date pills and bubbles, with stable keys for animateItem(). */
sealed interface ChatItem {
    val key: String

    data class Day(val date: LocalDate) : ChatItem {
        override val key: String get() = "day-$date"
    }

    data class Bubble(
        val message: Message,
        val isOwn: Boolean,
        /** First of a run from one sender: carries the tail corner and, in channels, the name. */
        val startsGroup: Boolean,
        val mark: DeliveryMark?
    ) : ChatItem {
        override val key: String get() = "msg-${message.id}"
    }
}

/** Desktop ChatView: a new group after 5 minutes, another sender or another day. */
const val GROUP_BREAK_MILLIS = 5 * 60 * 1000L

fun buildChatItems(
    messages: List<Message>,
    currentUserId: Long,
    zone: ZoneId = ZoneId.systemDefault()
): List<ChatItem> {
    val items = ArrayList<ChatItem>(messages.size + 4)
    var previous: Message? = null
    var previousMillis = 0L
    var previousDay: LocalDate? = null
    messages.forEach { message ->
        val millis = DateTimeUtils.parseIso8601ToMillis(message.createdAt)
        val day = Instant.ofEpochMilli(millis).atZone(zone).toLocalDate()
        val newDay = day != previousDay
        if (newDay) items += ChatItem.Day(day)
        val startsGroup = newDay || previous?.senderId != message.senderId || millis - previousMillis > GROUP_BREAK_MILLIS
        val isOwn = message.senderId == currentUserId
        items += ChatItem.Bubble(message, isOwn, startsGroup, deliveryMark(message, isOwn))
        previous = message
        previousMillis = millis
        previousDay = day
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
