package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DeliveryStatus
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.ui.components.BubblePosition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/** Bubble grouping (UI layer v2): first / middle / last radii, meta only where it says something. */
class ChatGroupingTest {

    private val me = 1L
    private val peer = 2L

    private fun msg(id: Long, from: Long, minute: Int, status: DeliveryStatus? = null, edited: Boolean = false, day: Int = 2) = Message(
        id = id, conversationType = ConversationType.DIRECT, targetId = if (from == me) peer else me,
        senderId = from, text = "m$id", createdAt = "2026-10-%02dT09:%02d:00.000Z".format(day, minute),
        deliveryStatus = status, updatedAt = if (edited) "2026-10-02T10:00:00.000Z" else null
    )

    private fun bubbles(vararg messages: Message) =
        buildChatItems(messages.toList(), currentUserId = me, zone = ZoneOffset.UTC)
            .filterIsInstance<ChatItem.Bubble>().associateBy { it.message.id }

    @Test
    fun aRunFromOneSenderIsFirstMiddleLast() {
        val b = bubbles(msg(1, peer, 0), msg(2, peer, 1), msg(3, peer, 2), msg(4, peer, 3))
        assertEquals(BubblePosition.FIRST, b.getValue(1).position)
        assertEquals(BubblePosition.MIDDLE, b.getValue(2).position)
        assertEquals(BubblePosition.MIDDLE, b.getValue(3).position)
        assertEquals(BubblePosition.LAST, b.getValue(4).position)
    }

    @Test
    fun aLoneMessageIsSingle() {
        val b = bubbles(msg(1, peer, 0), msg(2, me, 1), msg(3, peer, 2))
        b.values.forEach { assertEquals("message ${it.message.id}", BubblePosition.SINGLE, it.position) }
    }

    @Test
    fun anotherSenderOrMoreThanFiveMinutesStartsANewGroup() {
        val b = bubbles(
            msg(1, peer, 0), msg(2, peer, 5), // exactly 5 minutes: same group
            msg(3, peer, 11), // 6 minutes later: new group
            msg(4, me, 12), msg(5, me, 13)
        )
        assertEquals(BubblePosition.FIRST, b.getValue(1).position)
        assertEquals(BubblePosition.LAST, b.getValue(2).position)
        assertEquals(BubblePosition.SINGLE, b.getValue(3).position)
        assertEquals(BubblePosition.FIRST, b.getValue(4).position)
        assertEquals(BubblePosition.LAST, b.getValue(5).position)
    }

    @Test
    fun aNewDayStartsANewGroupEvenFromTheSameSender() {
        val b = bubbles(msg(1, peer, 58, day = 1), msg(2, peer, 0, day = 2))
        assertEquals(BubblePosition.SINGLE, b.getValue(1).position)
        assertEquals(BubblePosition.SINGLE, b.getValue(2).position)
    }

    @Test
    fun theTailBelongsOnlyToTheFirstBubbleOfAGroup() {
        val b = bubbles(msg(1, peer, 0), msg(2, peer, 1), msg(3, peer, 2))
        assertTrue(b.getValue(1).startsGroup)
        assertFalse(b.getValue(2).startsGroup)
        assertFalse(b.getValue(3).startsGroup)
    }

    @Test
    fun timeAndStateShowOnTheLastBubbleOfAGroup() {
        val b = bubbles(msg(1, me, 0, DeliveryStatus.READ), msg(2, me, 1, DeliveryStatus.READ), msg(3, me, 2, DeliveryStatus.READ))
        assertFalse(b.getValue(1).showsMeta)
        assertFalse(b.getValue(2).showsMeta)
        assertTrue(b.getValue(3).showsMeta)
    }

    @Test
    fun anEarlierBubbleKeepsItsMetaWhenItSaysSomethingTheLastDoesNot() {
        val b = bubbles(
            msg(1, me, 0, DeliveryStatus.DELIVERED), // older one only delivered while the last is read
            msg(2, me, 1, DeliveryStatus.READ, edited = true), // «изменено» is per message
            msg(3, me, 2, DeliveryStatus.READ)
        )
        assertTrue("its own delivery state differs from the group's last", b.getValue(1).showsMeta)
        assertTrue("edited", b.getValue(2).showsMeta)
        assertTrue(b.getValue(3).showsMeta)
    }

    @Test
    fun keysStayUniqueAndStable() {
        val items = buildChatItems(listOf(msg(1, peer, 0), msg(2, me, 1)), currentUserId = me, zone = ZoneOffset.UTC)
        assertEquals(listOf("day-2026-10-02", "msg-1", "msg-2"), items.map { it.key })
    }
}
