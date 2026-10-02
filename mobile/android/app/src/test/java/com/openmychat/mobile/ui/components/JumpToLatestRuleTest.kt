package com.openmychat.mobile.ui.components

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** «↓ N новых» shows when there is something below the reader, never at the bottom. */
class JumpToLatestRuleTest {

    @Test
    fun hiddenAtTheBottom() {
        assertFalse(JumpToLatest.isVisible(unseen = 0, itemsBelowViewport = 0))
        assertFalse("unseen resets at the bottom; a stale count must not show", JumpToLatest.isVisible(unseen = 3, itemsBelowViewport = 0))
    }

    @Test
    fun newMessagesBelowShowThePillAtOnce() {
        assertTrue(JumpToLatest.isVisible(unseen = 1, itemsBelowViewport = 1))
    }

    @Test
    fun readingFarUpShowsThePillWithoutACount() {
        assertFalse(JumpToLatest.isVisible(unseen = 0, itemsBelowViewport = JumpToLatest.SCROLLED_AWAY_ITEMS - 1))
        assertTrue(JumpToLatest.isVisible(unseen = 0, itemsBelowViewport = JumpToLatest.SCROLLED_AWAY_ITEMS))
    }
}
