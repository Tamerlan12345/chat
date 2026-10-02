package com.openmychat.mobile.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Brand tokens that Material's color scheme has no slot for. Values are the design brief's
 * (docs/superpowers/plans/2026-10-02-design-brief.md), taken from desktop `styles/theme.css`.
 */
@Immutable
data class CentyTokens(
    /** Cards and incoming bubbles. */
    val card: Color,
    /** Hairline borders instead of shadows. */
    val border: Color,
    val textStrong: Color,
    val textSecondary: Color,
    /** Error box, like desktop `.login-error-box`. */
    val dangerSoft: Color,
    val dangerLine: Color,
    val dangerText: Color
)

internal val LightCentyTokens = CentyTokens(
    card = Color(0xFFFFFFFF),
    border = Color(0x1A181838), // rgba(24,24,56,.10)
    textStrong = Color(0xFF16161D),
    textSecondary = Color(0xFF4A4A55),
    dangerSoft = Color(0x14D9363B), // rgba(217,54,59,.08)
    dangerLine = Color(0x4DD9363B), // rgba(217,54,59,.30)
    dangerText = Color(0xFFB4232A)
)

internal val DarkCentyTokens = CentyTokens(
    card = Color(0xFF2B2B32),
    border = Color(0x16FFFFFF), // rgba(255,255,255,.085)
    textStrong = Color(0xFFF4F4F7),
    textSecondary = Color(0xFFBDBDC7),
    dangerSoft = Color(0x24E5484D), // rgba(229,72,77,.14)
    dangerLine = Color(0x66E5484D), // rgba(229,72,77,.40)
    dangerText = Color(0xFFFF8F8F)
)

internal val LocalCentyTokens = staticCompositionLocalOf { LightCentyTokens }

object CentyTheme {
    val tokens: CentyTokens
        @Composable
        @ReadOnlyComposable
        get() = LocalCentyTokens.current
}
