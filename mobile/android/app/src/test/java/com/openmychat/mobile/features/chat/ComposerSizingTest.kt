package com.openmychat.mobile.features.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The composer grows from one to six lines, then scrolls inside. */
class ComposerSizingTest {

    @Test
    fun growsLineByLineUpToSix() {
        assertEquals(1, ComposerSizing.visibleLines(0))
        assertEquals(1, ComposerSizing.visibleLines(1))
        assertEquals(4, ComposerSizing.visibleLines(4))
        assertEquals(6, ComposerSizing.visibleLines(6))
    }

    @Test
    fun capsAtSixAndScrollsBeyond() {
        assertEquals(6, ComposerSizing.visibleLines(7))
        assertEquals(6, ComposerSizing.visibleLines(40))
        assertFalse(ComposerSizing.scrollsInternally(6))
        assertTrue(ComposerSizing.scrollsInternally(7))
    }
}
