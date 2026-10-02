package com.openmychat.mobile.ui.navigation

import kotlin.math.max
import kotlin.math.min

/**
 * The gesture-bar inset while the bottom bar slides (inbox ↔ chat). The screen above consumes the
 * inset only by the part of the bar still on screen, so whatever it pins to the bottom (the chat
 * composer) sits `max(visible bar, gesture inset)` above the bottom edge and moves continuously:
 * resting on the bar while it is there, on the gesture bar once it has gone.
 */
object NavBarInset {
    /** Inset (px) the content consumes when [barVisiblePx] of the bar is on screen. */
    fun consumedBottom(navInsetPx: Int, barVisiblePx: Int): Int = min(navInsetPx, barVisiblePx).coerceAtLeast(0)

    /** Distance (px) from the bottom edge to the bottom of bottom-pinned content. */
    fun composerLift(navInsetPx: Int, barVisiblePx: Int): Int {
        val visible = barVisiblePx.coerceAtLeast(0)
        return visible + (navInsetPx - consumedBottom(navInsetPx, visible))
            .let { padding -> max(0, padding) }
    }
}

/**
 * The part of the bottom bar on screen right now (px), measured by the navigation shell in the same
 * layout pass. Read it in layout only. Zero where there is no bar (tests, previews, the rail).
 */
val LocalBottomBarVisible = androidx.compose.runtime.staticCompositionLocalOf<() -> Int> { { 0 } }
