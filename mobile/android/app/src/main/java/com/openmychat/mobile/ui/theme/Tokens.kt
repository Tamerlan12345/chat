package com.openmychat.mobile.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * The design brief's tokens (docs/superpowers/plans/2026-10-02-design-brief.md), taken one to one
 * from desktop `styles/theme.css`. The Material color scheme is derived from these (Theme.kt);
 * views read either a Material role or a token here, never raw hex.
 */
@Immutable
data class CentyTokens(
    val isDark: Boolean,
    /** `bg-main`: chat background, forms. */
    val canvas: Color,
    /** `bg-sidebar`: inbox and grouped lists. */
    val list: Color,
    /** `bg-rail`: navigation bar and rail. */
    val frame: Color,
    /** `bg-card`: cards and incoming bubbles. */
    val card: Color,
    /** `bg-elevated`: sheets, menus, dialogs, snackbars. */
    val elevated: Color,
    val textStrong: Color,
    val textMain: Color,
    val textSecondary: Color,
    /** Time, counters, hints. */
    val textDim: Color,
    /** Hairlines and bubble outlines instead of shadows. */
    val border: Color,
    val borderStrong: Color,
    /** `bg-hover` / `bg-active`: skeleton blocks, pressed rows, day pills. */
    val hover: Color,
    val active: Color,
    val primary: Color,
    /** Own bubble fill, selected row. */
    val primarySoft: Color,
    /** Own bubble outline. */
    val primaryLine: Color,
    /** Own bubble text, links, read ticks. */
    val accentText: Color,
    val danger: Color,
    val dangerText: Color,
    val dangerSoft: Color,
    val dangerLine: Color,
    /** Filled destructive buttons (end call): white on it is at least 5:1. */
    val dangerFill: Color,
    val success: Color,
    val successText: Color,
    val successSoft: Color,
    val successLine: Color,
    /** Filled positive buttons (accept call). */
    val successFill: Color,
    val warning: Color,
    val warningText: Color,
    val warningSoft: Color,
    val warningLine: Color,
    /** Presence dots only. */
    val online: Color,
    val away: Color,
    val dnd: Color,
    val offline: Color,
    /** Channel avatars: slate instead of a per-person hue. */
    val channelAvatar: Color
)

internal val LightCentyTokens = CentyTokens(
    isDark = false,
    canvas = Color(0xFFFCFCFD),
    list = Color(0xFFF4F4F7),
    frame = Color(0xFFECECF1),
    card = Color(0xFFFFFFFF),
    elevated = Color(0xFFFFFFFF),
    textStrong = Color(0xFF16161D),
    textMain = Color(0xFF2B2B34),
    textSecondary = Color(0xFF4A4A55),
    textDim = Color(0xFF686874),
    border = Color(0x1A181838), // rgba(24,24,56,.10)
    borderStrong = Color(0x2B181838), // rgba(24,24,56,.17)
    hover = Color(0x0B181838), // rgba(24,24,56,.045)
    active = Color(0x14181838), // rgba(24,24,56,.08)
    primary = Color(0xFF5B4EE6),
    primarySoft = Color(0x1A5B4EE6), // rgba(91,78,230,.10)
    primaryLine = Color(0x4D5B4EE6), // rgba(91,78,230,.30)
    accentText = Color(0xFF4A3DD2),
    danger = Color(0xFFD9363B),
    dangerText = Color(0xFFB4232A),
    dangerSoft = Color(0x14D9363B), // rgba(217,54,59,.08)
    dangerLine = Color(0x4DD9363B), // rgba(217,54,59,.30)
    dangerFill = Color(0xFFC9302C),
    success = Color(0xFF1F9D61),
    successText = Color(0xFF137446),
    successSoft = Color(0x1A1F9D61), // rgba(31,157,97,.10)
    successLine = Color(0x4D1F9D61), // rgba(31,157,97,.30)
    successFill = Color(0xFF1A7F45),
    warning = Color(0xFFC98212),
    warningText = Color(0xFF8A5700),
    warningSoft = Color(0x1AC98212), // rgba(201,130,18,.10)
    warningLine = Color(0x52C98212), // rgba(201,130,18,.32)
    online = Color(0xFF2DA44E),
    away = Color(0xFFD4951C),
    dnd = Color(0xFFD9363B),
    offline = Color(0xFF9A9AA6),
    channelAvatar = Color(0xFF475569)
)

internal val DarkCentyTokens = CentyTokens(
    isDark = true,
    canvas = Color(0xFF24242A),
    list = Color(0xFF1E1E24),
    frame = Color(0xFF19191E),
    card = Color(0xFF2B2B32),
    elevated = Color(0xFF303038),
    textStrong = Color(0xFFF4F4F7),
    textMain = Color(0xFFDFDFE5),
    textSecondary = Color(0xFFBDBDC7),
    textDim = Color(0xFF9898A4),
    border = Color(0x16FFFFFF), // rgba(255,255,255,.085)
    borderStrong = Color(0x26FFFFFF), // rgba(255,255,255,.15)
    hover = Color(0x0EFFFFFF), // rgba(255,255,255,.055)
    active = Color(0x17FFFFFF), // rgba(255,255,255,.09)
    primary = Color(0xFF6457EE),
    primarySoft = Color(0x29968CFF), // rgba(150,140,255,.16)
    primaryLine = Color(0x66968CFF), // rgba(150,140,255,.40)
    accentText = Color(0xFFB0A9FF),
    danger = Color(0xFFE5484D),
    dangerText = Color(0xFFFF8F8F),
    dangerSoft = Color(0x24E5484D), // rgba(229,72,77,.14)
    dangerLine = Color(0x66E5484D), // rgba(229,72,77,.40)
    dangerFill = Color(0xFFC9302C),
    success = Color(0xFF3FB97A),
    successText = Color(0xFF6FD9A2),
    successSoft = Color(0x243FB97A), // rgba(63,185,122,.14)
    successLine = Color(0x663FB97A), // rgba(63,185,122,.40)
    successFill = Color(0xFF1A7F45),
    warning = Color(0xFFE5A13A),
    warningText = Color(0xFFF3C26F),
    warningSoft = Color(0x24E5A13A), // rgba(229,161,58,.14)
    warningLine = Color(0x66E5A13A), // rgba(229,161,58,.40)
    online = Color(0xFF3FB950),
    away = Color(0xFFE5A13A),
    dnd = Color(0xFFE5484D),
    offline = Color(0xFF7D7D89),
    channelAvatar = Color(0xFF3A3A44)
)

internal val LocalCentyTokens = staticCompositionLocalOf { LightCentyTokens }

object CentyTheme {
    val tokens: CentyTokens
        @Composable
        @ReadOnlyComposable
        get() = LocalCentyTokens.current
}
