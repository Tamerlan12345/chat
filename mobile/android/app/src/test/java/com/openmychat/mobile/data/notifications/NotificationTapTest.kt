package com.openmychat.mobile.data.notifications

import com.openmychat.mobile.data.model.ConversationType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * Final review I3: only the app's own notification can open a chat. A tap reaches the app through a
 * non-exported activity ([NotificationOpenActivity]); it is handed over in memory, never as extras
 * of the exported launcher, and it opens the chat only for the account the notification was for.
 */
class NotificationTapTest {

    @Before
    fun clean() {
        NotificationTaps.clear()
    }

    @Test
    fun aTapOfTheAppsOwnNotificationNamesTheChatAndItsAccount() {
        val tap = NotificationTap.parse(type = "direct", targetId = 5, title = "Иванов", account = 1)
        assertEquals(NotificationTap(ConversationType.DIRECT, 5, "Иванов", 1), tap)
    }

    @Test
    fun anythingOutsideTheContractIsNoTap() {
        assertNull(NotificationTap.parse("group", 5, "x", 1))
        assertNull(NotificationTap.parse("direct", 0, "x", 1))
        assertNull(NotificationTap.parse(null, 5, "x", 1))
        assertNull("a notification without an account opens nothing", NotificationTap.parse("channel", 5, "x", 0))
    }

    @Test
    fun aTapOpensTheChatOnceAndOnlyForItsAccount() {
        NotificationTaps.offer(NotificationTap(ConversationType.CHANNEL, 7, "Общий", account = 1))

        assertNull("another account is signed in now", NotificationTaps.take(currentAccount = 2))
        assertNull("dropped, not kept for later", NotificationTaps.take(currentAccount = 1))

        NotificationTaps.offer(NotificationTap(ConversationType.CHANNEL, 7, "Общий", account = 1))
        assertEquals(7L, NotificationTaps.take(currentAccount = 1)?.targetId)
        assertNull("taken once", NotificationTaps.take(currentAccount = 1))
    }

    @Test
    fun signedOutATapWaitsForTheSignIn() {
        NotificationTaps.offer(NotificationTap(ConversationType.DIRECT, 5, "Иванов", account = 1))
        assertNull(NotificationTaps.take(currentAccount = null))
        assertEquals(5L, NotificationTaps.take(currentAccount = 1)?.targetId)
    }
}
