package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DeliveryStatus
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.ui.components.DeliveryMark
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneOffset

class ChatPresentationTest {

    private val me = 1L
    private val peer = 2L

    private fun msg(id: Long, from: Long, at: String, status: DeliveryStatus? = null) = Message(
        id = id, conversationType = ConversationType.DIRECT, targetId = if (from == me) peer else me,
        senderId = from, text = "m$id", createdAt = at, deliveryStatus = status
    )

    // --- auto-scroll: only follow new messages when the reader is already at the bottom ----------

    @Test
    fun anIncomingMessageScrollsOnlyWhenTheReaderIsAtTheBottom() {
        assertEquals(FollowDecision(scrollToEnd = true, unseen = 0), FollowPolicy.onAppended(atBottom = true, ownAppended = false, incomingAppended = 1, unseen = 0))
        assertEquals(FollowDecision(scrollToEnd = false, unseen = 2), FollowPolicy.onAppended(atBottom = false, ownAppended = false, incomingAppended = 2, unseen = 0))
        assertEquals(FollowDecision(scrollToEnd = false, unseen = 3), FollowPolicy.onAppended(atBottom = false, ownAppended = false, incomingAppended = 1, unseen = 2))
    }

    @Test
    fun sendingAlwaysJumpsToTheNewBubbleAndClearsThePill() {
        assertEquals(FollowDecision(scrollToEnd = true, unseen = 0), FollowPolicy.onAppended(atBottom = false, ownAppended = true, incomingAppended = 1, unseen = 4))
    }

    @Test
    fun onlyMessagesAfterThePreviousLastCountAsAppended() {
        val history = listOf(msg(1, peer, "2026-10-02T09:00:00.000Z"), msg(2, me, "2026-10-02T09:01:00.000Z"))
        val now = history + msg(3, peer, "2026-10-02T09:02:00.000Z") + msg(4, me, "2026-10-02T09:03:00.000Z")

        assertEquals(listOf(3L, 4L), FollowPolicy.appendedSince(previousLastId = 2, messages = now).map { it.id })
        assertEquals(emptyList<Long>(), FollowPolicy.appendedSince(previousLastId = 4, messages = now).map { it.id })
        // First load (nothing seen yet) is not "new messages".
        assertEquals(emptyList<Long>(), FollowPolicy.appendedSince(previousLastId = null, messages = now).map { it.id })
        // A deleted previous last message: nothing is guessed as new.
        assertEquals(emptyList<Long>(), FollowPolicy.appendedSince(previousLastId = 99, messages = now).map { it.id })
    }

    // --- grouping and day separators --------------------------------------------------------------

    @Test
    fun consecutiveMessagesFromOneSenderGroupWithinFiveMinutesOfTheSameDay() {
        val items = buildChatItems(
            listOf(
                msg(1, peer, "2026-10-01T09:00:00.000Z"),
                msg(2, peer, "2026-10-01T09:04:00.000Z"),
                msg(3, peer, "2026-10-01T09:20:00.000Z"),
                msg(4, me, "2026-10-01T09:21:00.000Z"),
                msg(5, me, "2026-10-02T09:00:00.000Z")
            ),
            currentUserId = me, zone = ZoneOffset.UTC
        )
        val days = items.filterIsInstance<ChatItem.Day>().map { it.date }
        assertEquals(listOf(LocalDate.of(2026, 10, 1), LocalDate.of(2026, 10, 2)), days)
        val bubbles = items.filterIsInstance<ChatItem.Bubble>().associateBy { it.message.id }
        assertTrue(bubbles.getValue(1).startsGroup)
        assertFalse("4 minutes later, same sender", bubbles.getValue(2).startsGroup)
        assertTrue("16 minutes later", bubbles.getValue(3).startsGroup)
        assertTrue("another sender", bubbles.getValue(4).startsGroup)
        assertTrue("another day", bubbles.getValue(5).startsGroup)
        assertEquals(items.map { it.key }.distinct().size, items.size)
    }

    @Test
    fun ownMessagesShowSentDeliveredAndReadIncomingShowNothing() {
        assertEquals(DeliveryMark.SENT, deliveryMark(msg(1, me, "2026-10-01T09:00:00.000Z"), isOwn = true))
        assertEquals(DeliveryMark.DELIVERED, deliveryMark(msg(1, me, "2026-10-01T09:00:00.000Z", DeliveryStatus.DELIVERED), isOwn = true))
        assertEquals(DeliveryMark.READ, deliveryMark(msg(1, me, "2026-10-01T09:00:00.000Z", DeliveryStatus.READ), isOwn = true))
        assertEquals(null, deliveryMark(msg(1, peer, "2026-10-01T09:00:00.000Z", DeliveryStatus.READ), isOwn = false))
    }
}
