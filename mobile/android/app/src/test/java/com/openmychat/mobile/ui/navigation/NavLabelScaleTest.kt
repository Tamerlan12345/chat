package com.openmychat.mobile.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Test

/** Bottom bar labels stop growing past 1.3x so four of them fit the bar at the 2.0 system font scale. */
class NavLabelScaleTest {

    @Test
    fun normalScalesAreLeftAlone() {
        assertEquals(1.0f, NavLabelScale.cap(1.0f), 0f)
        assertEquals(1.15f, NavLabelScale.cap(1.15f), 0f)
        assertEquals(0.85f, NavLabelScale.cap(0.85f), 0f)
    }

    @Test
    fun largeScalesAreCapped() {
        assertEquals(NavLabelScale.MAX, NavLabelScale.cap(2.0f), 0f)
        assertEquals(NavLabelScale.MAX, NavLabelScale.cap(1.5f), 0f)
    }
}
