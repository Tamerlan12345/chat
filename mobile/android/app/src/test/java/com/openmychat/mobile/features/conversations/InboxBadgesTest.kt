package com.openmychat.mobile.features.conversations

import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.DirectConversation
import org.junit.Assert.assertEquals
import org.junit.Test

/** Badge rules of the polish pass: conversations, not messages; nothing on the open segment. */
class InboxBadgesTest {

    private fun direct(id: Long, unread: Int) = DirectConversation(userId = id, fullName = "Коллега $id", unreadCount = unread)
    private fun channel(id: Long, unread: Int) = Channel(id = id, name = "канал-$id", unreadCount = unread)

    @Test
    fun segmentsCountConversationsWithSomethingUnreadNotMessages() {
        assertEquals(2, InboxBadges.unreadConversations(listOf(direct(1, 5), direct(2, 0), direct(3, 1))))
        assertEquals(1, InboxBadges.unreadChannels(listOf(channel(1, 0), channel(2, 40))))
    }

    @Test
    fun theOpenSegmentShowsNoCounter() {
        assertEquals(0, InboxBadges.segmentCount(selected = true, unreadConversations = 3))
        assertEquals(3, InboxBadges.segmentCount(selected = false, unreadConversations = 3))
    }
}
