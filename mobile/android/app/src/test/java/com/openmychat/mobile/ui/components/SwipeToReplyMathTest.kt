package com.openmychat.mobile.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Swipe-to-reply: the arrow fills toward a threshold; only a release past it starts a reply. */
class SwipeToReplyMathTest {

    private val threshold = 100f

    @Test
    fun onlyADragTowardTheStartMovesTheBubble() {
        assertEquals(0f, SwipeToReplyMath.offsetFor(rawDrag = 40f, threshold = threshold, rtl = false), 0f)
        assertEquals(-40f, SwipeToReplyMath.offsetFor(rawDrag = -40f, threshold = threshold, rtl = false), 0f)
        // Right-to-left layouts mirror the direction.
        assertEquals(40f, SwipeToReplyMath.offsetFor(rawDrag = 40f, threshold = threshold, rtl = true), 0f)
        assertEquals(0f, SwipeToReplyMath.offsetFor(rawDrag = -40f, threshold = threshold, rtl = true), 0f)
    }

    @Test
    fun theArrowFillsInProportionAndStopsAtFull() {
        assertEquals(0f, SwipeToReplyMath.progress(0f, threshold), 0.001f)
        assertEquals(0.5f, SwipeToReplyMath.progress(-50f, threshold), 0.001f)
        assertEquals(1f, SwipeToReplyMath.progress(-100f, threshold), 0.001f)
        assertEquals(1f, SwipeToReplyMath.progress(-160f, threshold), 0.001f)
    }

    @Test
    fun releasingShortOfTheThresholdDoesNothing() {
        assertFalse(SwipeToReplyMath.triggers(-99f, threshold))
        assertTrue(SwipeToReplyMath.triggers(-100f, threshold))
        assertTrue(SwipeToReplyMath.triggers(-130f, threshold))
    }

    @Test
    fun beyondTheThresholdTheBubbleResists() {
        val past = SwipeToReplyMath.offsetFor(rawDrag = -200f, threshold = threshold, rtl = false)
        assertTrue("moves less than the finger past the threshold: $past", past > -200f && past < -100f)
        val far = SwipeToReplyMath.offsetFor(rawDrag = -10_000f, threshold = threshold, rtl = false)
        assertTrue("never travels further than 1.6 thresholds: $far", far >= -160f)
    }
}
