package com.openmychat.mobile.ui.navigation

import androidx.window.core.layout.WindowSizeClass
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ListDetailBreakpointTest {

    @Test
    fun listAndDetailShareTheScreenOnlyFromExpandedWidth() {
        assertFalse("compact", usesListDetailPanes(WindowSizeClass(minWidthDp = 411, minHeightDp = 891)))
        assertFalse("medium (e.g. 600-839dp) stays single-pane", usesListDetailPanes(WindowSizeClass(minWidthDp = 700, minHeightDp = 900)))
        assertTrue("expanded", usesListDetailPanes(WindowSizeClass(minWidthDp = 840, minHeightDp = 900)))
    }
}
