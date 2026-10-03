package com.openmychat.mobile.features.chat

import androidx.compose.ui.geometry.Offset
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.message
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Rapid sends each get their own landing; nothing is lost to a replaced flight. */
class LandingStateTest {

    private val landing = LandingState()

    @Test
    fun twoQuickSendsOfTheSameTextLandInTheirOwnBubbles() {
        landing.launch("Да", Offset(10f, 2000f))
        landing.launch("Да", Offset(10f, 2000f))

        assertTrue(landing.claim("msg-1", message(id = 1, from = ME, to = 3, text = "Да")))
        assertTrue(landing.claim("msg-2", message(id = 2, from = ME, to = 3, text = "Да")))
        assertEquals(listOf("msg-1", "msg-2"), landing.flights.map { it.claimedKey })
        assertTrue(landing.hides("msg-1") && landing.hides("msg-2"))
    }

    @Test
    fun aBubbleWithOtherTextIsNotCarried() {
        landing.launch("Первое", Offset.Zero)
        assertFalse(landing.claim("msg-9", message(id = 9, from = ME, to = 3, text = "Другое")))
        assertFalse(landing.hides("msg-9"))
    }

    @Test
    fun theTargetFollowsTheBubbleUntilItLands() {
        landing.launch("Текст", Offset.Zero)
        landing.claim("msg-1", message(id = 1, from = ME, to = 3, text = "Текст"))
        landing.aim("msg-1", Offset(100f, 500f))
        landing.aim("msg-1", Offset(100f, 480f))
        assertEquals(Offset(100f, 480f), landing.flights.single().target)
    }
}
