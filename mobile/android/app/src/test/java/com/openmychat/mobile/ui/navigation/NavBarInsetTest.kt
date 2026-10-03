package com.openmychat.mobile.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * While the bottom bar slides (inbox ↔ chat), the screen above consumes the gesture-bar inset only
 * by the part of the bar still on screen, so the chat composer's distance from the bottom edge is
 * max(visible bar, gesture inset) and changes continuously.
 */
class NavBarInsetTest {

    private val inset = 63 // gesture bar, px
    private val bar = 210 + inset // NavigationBar pads itself for the gesture bar

    private fun fractions() = (0..20).map { it / 20f }

    @Test
    fun aFullyShownBarConsumesTheWholeInsetAHiddenOneNothing() {
        assertEquals(inset, NavBarInset.consumedBottom(navInsetPx = inset, barVisiblePx = bar))
        assertEquals(0, NavBarInset.consumedBottom(navInsetPx = inset, barVisiblePx = 0))
        assertEquals(20, NavBarInset.consumedBottom(navInsetPx = inset, barVisiblePx = 20))
    }

    @Test
    fun theComposerBottomFollowsTheBarWithoutJumpsInBothDirections() {
        val hiding = fractions().map { f -> NavBarInset.composerLift(inset, (bar * (1f - f)).toInt()) }
        val showing = fractions().map { f -> NavBarInset.composerLift(inset, (bar * f).toInt()) }
        // Monotonic: never moves against the slide.
        assertTrue(hiding.zipWithNext().all { (a, b) -> b <= a })
        assertTrue(showing.zipWithNext().all { (a, b) -> b >= a })
        // Continuous: no step larger than one slide step of the bar.
        val step = bar / 20 + 1
        assertTrue(hiding.zipWithNext().all { (a, b) -> a - b <= step })
        assertTrue(showing.zipWithNext().all { (a, b) -> b - a <= step })
        // Rest positions: above the bar when shown, above the gesture bar when hidden.
        assertEquals(bar, showing.last())
        assertEquals(inset, hiding.last())
    }
}
