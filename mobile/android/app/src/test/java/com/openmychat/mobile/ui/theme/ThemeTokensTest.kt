package com.openmychat.mobile.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Material scheme is derived from the brief's tokens, and the text pairs keep WCAG AA contrast. */
class ThemeTokensTest {

    @Test
    fun filledButtonsUseTheBriefPrimaryWithWhiteTextInBothThemes() {
        assertEquals(Color(0xFF5B4EE6), LightColorScheme.primary)
        assertEquals(Color(0xFF6457EE), DarkColorScheme.primary)
        assertEquals(Color.White, LightColorScheme.onPrimary)
        assertEquals(Color.White, DarkColorScheme.onPrimary)
        // The light lilac stays accent text (links, own bubbles), never a button fill.
        assertEquals(Color(0xFFB0A9FF), DarkCentyTokens.accentText)
    }

    @Test
    fun surfacesFollowTheDesktopDepths() {
        assertEquals(LightCentyTokens.canvas, LightColorScheme.background)
        assertEquals(DarkCentyTokens.canvas, DarkColorScheme.background)
        assertEquals(LightCentyTokens.list, LightColorScheme.surface)
        assertEquals(DarkCentyTokens.list, DarkColorScheme.surface)
        // No tonal tint: elevation is tone plus a hairline.
        assertEquals(LightColorScheme.surface, LightColorScheme.surfaceTint)
        assertEquals(DarkColorScheme.surface, DarkColorScheme.surfaceTint)
    }

    @Test
    fun textPairsMeetAaContrast() {
        listOf(LightCentyTokens, DarkCentyTokens).forEach { t ->
            val theme = if (t.isDark) "dark" else "light"
            val ownBubble = t.primarySoft.compositeOver(t.canvas)
            val errorBox = t.dangerSoft.compositeOver(t.card)
            listOf(
                Triple("body on canvas", t.textMain, t.canvas),
                Triple("preview on list", t.textSecondary, t.list),
                Triple("time on list", t.textDim, t.list),
                Triple("time on card", t.textDim, t.card),
                Triple("own bubble text", t.accentText, ownBubble),
                Triple("error box text", t.dangerText, errorBox),
                Triple("white on primary", Color.White, t.primary),
                Triple("white on danger fill", Color.White, t.dangerFill),
                Triple("white on success fill", Color.White, t.successFill),
                Triple("white on channel avatar", Color.White, t.channelAvatar),
                // Foreground brand colour: text and outlined buttons, focused fields, cursors.
                Triple("accent text on elevated (dialog/sheet buttons)", t.accentText, t.elevated),
                Triple("accent text on card (focused field label)", t.accentText, t.card),
                Triple("accent text on list (inline/empty actions)", t.accentText, t.list),
                Triple("accent text on canvas", t.accentText, t.canvas),
                Triple("accent text on frame (call screen buttons)", t.accentText, t.frame),
                Triple("time in own bubble", t.textSecondary, ownBubble),
                Triple("selected nav item on its indicator", t.accentText, t.navIndicator)
            ).forEach { (name, fg, bg) ->
                val ratio = contrast(fg, bg)
                assertTrue("$theme $name: ${"%.2f".format(ratio)}:1", ratio >= 4.5)
            }
        }
    }

    @Test
    fun theSelectedNavigationPillStandsOffTheBar() {
        listOf(LightCentyTokens, DarkCentyTokens).forEach { t ->
            val ratio = contrast(t.navIndicator, t.frame)
            assertTrue("${if (t.isDark) "dark" else "light"} indicator vs frame: ${"%.2f".format(ratio)}:1", ratio >= 1.2)
        }
    }

    private fun contrast(a: Color, b: Color): Double {
        val la = a.luminance() + 0.05
        val lb = b.luminance() + 0.05
        return (maxOf(la, lb) / minOf(la, lb)).toDouble()
    }
}
