package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DeliveryStatus
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.SendState
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

    private fun msg(id: Long, from: Long, minute: Int, status: DeliveryStatus? = null, edited: Boolean = false, day: Int = 2, deleted: Boolean = false) = Message(
        id = id, conversationType = ConversationType.DIRECT, targetId = if (from == me) peer else me,
        senderId = from, text = if (deleted) "" else "m$id", createdAt = "2026-10-%02dT09:%02d:00.000Z".format(day, minute),
        deliveryStatus = status, updatedAt = if (edited) "2026-10-02T10:00:00.000Z" else null, isDeleted = deleted
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
    fun metaComesFromStableInputsNeverFromTheDeliveryState() {
        // History must not reflow when a status catches up: an older bubble that is only delivered
        // while the last one is read keeps the same (meta-less) geometry; only «изменено» adds meta.
        val b = bubbles(
            msg(1, me, 0, DeliveryStatus.DELIVERED),
            msg(2, me, 1, DeliveryStatus.READ, edited = true),
            msg(3, me, 2, DeliveryStatus.READ)
        )
        assertFalse("a different delivery state alone shows nothing", b.getValue(1).showsMeta)
        assertTrue("edited", b.getValue(2).showsMeta)
        assertTrue(b.getValue(3).showsMeta)

        val caughtUp = bubbles(msg(1, me, 0, DeliveryStatus.READ), msg(2, me, 1, DeliveryStatus.READ, edited = true), msg(3, me, 2, DeliveryStatus.READ))
        caughtUp.keys.forEach { id -> assertEquals("message $id keeps its geometry", b.getValue(id).showsMeta, caughtUp.getValue(id).showsMeta) }
    }

    @Test
    fun aStalledEarlierSendShowsItsStateEvenInsideAGroup() {
        // Principle «never lose a message»: a queued or sending bubble behind a later one that is
        // further along must not hide its clock (ledger 2026-10-02, out-of-order QUEUED/SENDING).
        fun local(id: Long, minute: Int, state: SendState) = msg(id, me, minute).copy(clientMsgId = "k$id", sendState = state)
        fun marked(vararg messages: Message) = buildChatItems(messages.toList(), currentUserId = me, zone = ZoneOffset.UTC, markOverride = ::sendStateMark)
            .filterIsInstance<ChatItem.Bubble>().associateBy { it.message.id }

        val stalled = marked(local(1, 0, SendState.QUEUED), local(2, 1, SendState.SENDING), msg(3, me, 2, DeliveryStatus.READ))
        assertTrue("queued before a read bubble shows its clock", stalled.getValue(1).showsMeta)
        assertTrue("sending before a read bubble shows it too", stalled.getValue(2).showsMeta)
        assertTrue(stalled.getValue(3).showsMeta)

        val inOrder = marked(local(1, 0, SendState.SENDING), local(2, 1, SendState.QUEUED), local(3, 2, SendState.QUEUED))
        assertFalse("the head going out ahead of the queue says nothing new", inOrder.getValue(1).showsMeta)
        assertFalse("the same state as the group's last", inOrder.getValue(2).showsMeta)
        assertTrue(inOrder.getValue(3).showsMeta)

        val beforeFailed = marked(local(1, 0, SendState.QUEUED), local(2, 1, SendState.FAILED))
        assertTrue("a failed last bubble says nothing about the queued one", beforeFailed.getValue(1).showsMeta)
    }

    @Test
    fun aDeletedMessageKeepsItsPlaceInTheGroup() {
        val b = bubbles(msg(1, peer, 0), msg(2, peer, 1, deleted = true), msg(3, peer, 2))
        assertEquals(BubblePosition.FIRST, b.getValue(1).position)
        assertEquals(BubblePosition.MIDDLE, b.getValue(2).position)
        assertEquals(BubblePosition.LAST, b.getValue(3).position)
    }

    @Test
    fun deletedIsNotEdited() {
        // The server stamps updated_at on deletion; a tombstone is not «изменено».
        val b = bubbles(msg(1, peer, 0), msg(2, peer, 1, edited = true, deleted = true), msg(3, peer, 2))
        assertFalse(b.getValue(2).showsMeta)
        val last = bubbles(msg(1, peer, 0), msg(2, peer, 1, edited = true, deleted = true))
        assertTrue("the last bubble of a group still shows its time", last.getValue(2).showsMeta)
    }

    @Test
    fun keysStayUniqueAndStable() {
        val items = buildChatItems(listOf(msg(1, peer, 0), msg(2, me, 1)), currentUserId = me, zone = ZoneOffset.UTC)
        assertEquals(listOf("day-2026-10-02", "msg-1", "msg-2"), items.map { it.key })
    }
}
