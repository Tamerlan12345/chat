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
    fun uiLayerV2PairsMeetAaContrast() {
        listOf(LightCentyTokens, DarkCentyTokens).forEach { t ->
            val theme = if (t.isDark) "dark" else "light"
            val ownBubble = t.primarySoft.compositeOver(t.canvas)
            val tile = t.hover.compositeOver(t.card)
            listOf(
                // L3 surfaces: composer, banners, sticky date pill, lifted bars, menus.
                Triple("date pill text on elevated", t.textSecondary, t.elevated),
                Triple("lifted bar title on elevated", t.textStrong, t.elevated),
                Triple("composer banner quote on elevated", t.textSecondary, t.elevated),
                Triple("composer text on card", t.textMain, t.card),
                Triple("menu item on elevated", t.textMain, t.elevated),
                Triple("menu delete on elevated", t.dangerText, t.elevated),
                Triple("banner «Нет сети»", t.dangerText, t.dangerSoft.compositeOver(t.elevated)),
                Triple("banner «Переподключение…»", t.warningText, t.warningSoft.compositeOver(t.elevated)),
                Triple("banner «Снова в сети»", t.successText, t.successSoft.compositeOver(t.elevated)),
                // Bubbles and their rows.
                Triple("failed row text on canvas", t.dangerText, t.canvas),
                Triple("reply quote in own bubble", t.textSecondary, t.hover.compositeOver(ownBubble)),
                Triple("reply quote sender in own bubble", t.accentText, t.hover.compositeOver(ownBubble)),
                Triple("jump pill count", Color.White, t.primary),
                // Attachments.
                Triple("file name on tile", t.textStrong, tile),
                Triple("file size on tile", t.textSecondary, tile),
                Triple("PDF badge", t.dangerText, t.dangerSoft.compositeOver(t.card)),
                Triple("file badge", t.accentText, t.primarySoft.compositeOver(t.card)),
                // «Ознакомлен» stamp.
                Triple("acknowledged text", t.successText, t.successSoft.compositeOver(t.elevated))
            ).forEach { (name, fg, bg) ->
                val ratio = contrast(fg, bg)
                assertTrue("$theme $name: ${"%.2f".format(ratio)}:1", ratio >= 4.5)
            }
        }
    }

    @Test
    fun uiLayerV2GraphicsHoldThreeToOne() {
        listOf(LightCentyTokens, DarkCentyTokens).forEach { t ->
            val theme = if (t.isDark) "dark" else "light"
            val ownBubble = t.primarySoft.compositeOver(t.canvas)
            listOf(
                Triple("read ticks in own bubble", t.accentText, ownBubble),
                Triple("failed ⟲ in own bubble", t.dangerText, ownBubble),
                Triple("sent tick in own bubble", t.textSecondary, ownBubble),
                Triple("swipe-to-reply ring", t.accentText, t.primarySoft.compositeOver(t.canvas)),
                Triple("illustration indigo on list", t.accentText, t.list),
                Triple("illustration indigo on soft fill", t.accentText, t.primarySoft.compositeOver(t.card)),
                Triple("illustration line on list", t.textSecondary, t.list),
                Triple("illustration line on canvas", t.textSecondary, t.canvas),
                Triple("level meter bar on frame", t.accentText, t.frame),
                Triple("typing dots in a bubble", t.textDim, t.card)
            ).forEach { (name, fg, bg) ->
                val ratio = contrast(fg, bg)
                assertTrue("$theme $name: ${"%.2f".format(ratio)}:1", ratio >= 3.0)
            }
        }
    }

    @Test
    fun theScrimDimsLikeTheBrief() {
        assertEquals(Color(0x57141428), LightCentyTokens.scrim)
        assertEquals(Color(0xA308080C), DarkCentyTokens.scrim)
        // Overlays sit on L3: in dark the elevated tone must stand off the canvas (tone, not shadow).
        assertTrue(contrast(DarkCentyTokens.elevated, DarkCentyTokens.canvas) >= 1.15)
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
