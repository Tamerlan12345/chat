package com.openmychat.mobile.ui.theme

import androidx.compose.ui.unit.dp

/**
 * The spacing rhythm of the polish pass (design brief «Anti-"AI-generated" polish pass», rule 2):
 * 4 · 8 · 12 · 16 · 24 · 32, instead of 16 everywhere. Named uses below; everything else picks a
 * step of the rhythm.
 */
object CentySpace {
    val xs = 4.dp
    val s = 8.dp
    val m = 12.dp
    val l = 16.dp
    val xl = 24.dp
    val xxl = 32.dp

    /** Left and right edge of every screen. */
    val gutter = l

    /** Inside a row, and between an avatar and its text. */
    val rowGap = m

    /** Between sections, and above a section header. */
    val section = xl

    /** Below a section header. */
    val headerBelow = s

    /** Chat: between groups of messages. In a group the bubbles share one contour (see MessageBubble). */
    val chatGroupGap = s
}
