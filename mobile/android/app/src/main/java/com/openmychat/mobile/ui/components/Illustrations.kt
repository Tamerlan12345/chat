package com.openmychat.mobile.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * Authored spot illustrations for empty and error states (UI layer v2): 120dp line art in graphite
 * and the one indigo, soft primary fills, no gradients, no stock art. Each pairs with one sentence
 * and one action in [EmptyState] / [ErrorState].
 */
enum class Illustration {
    /** Inbox: two overlapping bubbles. */
    INBOX,

    /** Channels: a hash in a bubble. */
    CHANNELS,

    /** Announcements: a megaphone with a check. */
    ANNOUNCEMENTS,

    /** Offline: a cloud with a broken link. */
    OFFLINE,

    /** Search: a magnifier over an empty bubble. */
    SEARCH
}

/** Colours of the line art, from the theme tokens (so light and dark are both authored). */
@Immutable
data class IllustrationPalette(
    /** Graphite outline. */
    val line: Color,
    /** The indigo stroke (accent text tone, so it holds 3:1 on every plane). */
    val accent: Color,
    /** Soft primary fill, flattened. */
    val fill: Color,
    /** Paper: the card tone. */
    val paper: Color,
    /** Inner detail lines. */
    val faint: Color
)

@Composable
fun rememberIllustrationPalette(): IllustrationPalette {
    val t = CentyTheme.tokens
    return remember(t) {
        IllustrationPalette(
            line = t.textSecondary,
            accent = t.accentText,
            fill = t.primarySoft.compositeOver(t.card),
            paper = t.card,
            faint = t.textDim.copy(alpha = 0.55f)
        )
    }
}

@Composable
fun SpotIllustration(kind: Illustration, modifier: Modifier = Modifier, size: Dp = 120.dp) {
    val palette = rememberIllustrationPalette()
    val vector = remember(kind, palette) { kind.vector(palette) }
    Image(vector, contentDescription = null, modifier = modifier.size(size).testTag("illustration-${kind.name.lowercase()}"))
}

fun Illustration.vector(p: IllustrationPalette): ImageVector = when (this) {
    Illustration.INBOX -> inbox(p)
    Illustration.CHANNELS -> channels(p)
    Illustration.ANNOUNCEMENTS -> announcements(p)
    Illustration.OFFLINE -> offline(p)
    Illustration.SEARCH -> search(p)
}

private const val STROKE = 3f

private fun canvas(name: String, block: ImageVector.Builder.() -> Unit): ImageVector =
    ImageVector.Builder(name = name, defaultWidth = 120.dp, defaultHeight = 120.dp, viewportWidth = 120f, viewportHeight = 120f)
        .apply(block)
        .build()

private fun ImageVector.Builder.shape(fill: Color?, stroke: Color?, width: Float = STROKE, block: PathBuilder.() -> Unit) {
    path(
        fill = fill?.let { SolidColor(it) },
        stroke = stroke?.let { SolidColor(it) },
        strokeLineWidth = width,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
        pathBuilder = block
    )
}

private fun PathBuilder.roundRect(x: Float, y: Float, w: Float, h: Float, r: Float) {
    moveTo(x + r, y)
    lineTo(x + w - r, y)
    arcTo(r, r, 0f, false, true, x + w, y + r)
    lineTo(x + w, y + h - r)
    arcTo(r, r, 0f, false, true, x + w - r, y + h)
    lineTo(x + r, y + h)
    arcTo(r, r, 0f, false, true, x, y + h - r)
    lineTo(x, y + r)
    arcTo(r, r, 0f, false, true, x + r, y)
    close()
}

private fun PathBuilder.circle(cx: Float, cy: Float, r: Float) {
    moveTo(cx - r, cy)
    arcTo(r, r, 0f, false, true, cx + r, cy)
    arcTo(r, r, 0f, false, true, cx - r, cy)
    close()
}

private fun PathBuilder.line(vararg points: Float) {
    moveTo(points[0], points[1])
    var i = 2
    while (i < points.size) {
        lineTo(points[i], points[i + 1])
        i += 2
    }
}

/**
 * A speech bubble: body, a tail whose fill covers the body's hairline where they meet, and the
 * tail's two outer edges. [tailX] is the tail's base start, [toLeft] points it down-left.
 */
private fun ImageVector.Builder.bubble(
    x: Float, y: Float, w: Float, h: Float, r: Float,
    tailX: Float, toLeft: Boolean,
    fill: Color, stroke: Color
) {
    val bottom = y + h
    val tipX = if (toLeft) tailX - 6f else tailX + 22f
    val baseEnd = tailX + 16f
    shape(fill, stroke) { roundRect(x, y, w, h, r) }
    shape(fill, null) { line(tailX, bottom - 3f, tipX, bottom + 12f, baseEnd, bottom - 3f); close() }
    shape(null, stroke) { line(tailX, bottom, tipX, bottom + 12f, baseEnd, bottom) }
}

private fun inbox(p: IllustrationPalette) = canvas("inbox") {
    // Back bubble: a colleague's message on paper.
    bubble(14f, 20f, 62f, 44f, 12f, tailX = 26f, toLeft = true, fill = p.paper, stroke = p.line)
    shape(null, p.faint) { line(27f, 36f, 62f, 36f) }
    shape(null, p.faint) { line(27f, 47f, 50f, 47f) }
    // Front bubble: the reply, in the indigo.
    bubble(44f, 46f, 62f, 44f, 12f, tailX = 80f, toLeft = false, fill = p.fill, stroke = p.accent)
    shape(p.accent, null) { circle(62f, 68f, 3.5f) }
    shape(p.accent, null) { circle(75f, 68f, 3.5f) }
    shape(p.accent, null) { circle(88f, 68f, 3.5f) }
}

private fun channels(p: IllustrationPalette) = canvas("channels") {
    // A second bubble behind hints at many voices.
    shape(p.paper, p.line) { roundRect(36f, 14f, 66f, 40f, 12f) }
    bubble(18f, 30f, 76f, 58f, 14f, tailX = 30f, toLeft = true, fill = p.fill, stroke = p.accent)
    shape(null, p.accent, width = 4f) { line(51f, 44f, 47f, 76f) }
    shape(null, p.accent, width = 4f) { line(66f, 44f, 62f, 76f) }
    shape(null, p.accent, width = 4f) { line(40f, 54f, 74f, 54f) }
    shape(null, p.accent, width = 4f) { line(37f, 66f, 71f, 66f) }
}

private fun announcements(p: IllustrationPalette) = canvas("announcements") {
    // Handle under the horn.
    shape(p.paper, p.line) { line(36f, 70f, 41f, 92f, 52f, 92f, 49f, 72f); close() }
    // Back plate.
    shape(p.fill, p.accent) { roundRect(16f, 50f, 14f, 22f, 4f) }
    // The horn widening toward its mouth.
    shape(p.paper, p.line) { line(30f, 52f, 74f, 30f, 74f, 92f, 30f, 70f); close() }
    // Mouth rim.
    shape(null, p.line, width = 4f) { line(76f, 28f, 76f, 94f) }
    // Sound lines.
    shape(null, p.faint) { line(84f, 52f, 92f, 50f) }
    shape(null, p.faint) { line(84f, 62f, 94f, 62f) }
    // The check badge: acknowledged.
    shape(p.fill, p.accent) { circle(90f, 32f, 16f) }
    shape(null, p.accent, width = 4f) { line(82f, 32f, 88f, 38f, 98f, 26f) }
}

private fun offline(p: IllustrationPalette) = canvas("offline") {
    // Cloud: two small bumps and a big one.
    shape(p.paper, p.line) {
        moveTo(32f, 72f)
        arcTo(13f, 13f, 0f, false, true, 34f, 46f)
        arcTo(21f, 21f, 0f, false, true, 74f, 40f)
        arcTo(16f, 16f, 0f, false, true, 88f, 72f)
        close()
    }
    // The broken link: two halves pulled apart.
    shape(null, p.accent, width = 3.5f) { roundRect(30f, 86f, 26f, 13f, 6.5f) }
    shape(null, p.accent, width = 3.5f) { roundRect(64f, 86f, 26f, 13f, 6.5f) }
    // Sparks at the break.
    shape(null, p.accent) { line(60f, 80f, 60f, 76f) }
    shape(null, p.accent) { line(54f, 81f, 51f, 78f) }
    shape(null, p.accent) { line(66f, 81f, 69f, 78f) }
    shape(null, p.accent) { line(60f, 105f, 60f, 109f) }
}

private fun search(p: IllustrationPalette) = canvas("search") {
    // An empty bubble: nothing found.
    bubble(16f, 22f, 66f, 50f, 12f, tailX = 28f, toLeft = true, fill = p.paper, stroke = p.line)
    shape(null, p.faint) { line(30f, 40f, 46f, 40f) }
    // The magnifier over it.
    shape(p.fill, p.accent, width = 4f) { circle(74f, 70f, 18f) }
    shape(null, p.accent, width = 7f) { line(87f, 83f, 102f, 98f) }
}
