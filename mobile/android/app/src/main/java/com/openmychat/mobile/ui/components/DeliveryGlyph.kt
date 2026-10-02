package com.openmychat.mobile.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.sin

/** Delivery state of an own message, in the brief's order. Queued, sending and failed come from the send queue. */
enum class DeliveryMark { QUEUED, SENDING, SENT, DELIVERED, READ, FAILED }

fun deliveryLabel(mark: DeliveryMark): Int = when (mark) {
    DeliveryMark.QUEUED -> R.string.delivery_queued
    DeliveryMark.SENDING -> R.string.delivery_sending
    DeliveryMark.SENT -> R.string.delivery_sent
    DeliveryMark.DELIVERED -> R.string.delivery_delivered
    DeliveryMark.READ -> R.string.delivery_read
    DeliveryMark.FAILED -> R.string.delivery_failed
}

/**
 * The product's signature: the delivery glyph *draws itself* through ⏱ → ✓ → ✓✓ → ✓✓ (accent),
 * each state's stroke in 160 ms while the previous state fades out. Failed turns into a red ⟲ with
 * one 4dp shake and a warning haptic. Reduce motion: an instant swap, colour only; the haptic stays.
 *
 * Drawn paths, not icons: the glyphs share one stroke (1.6dp, round caps) with the bubble type.
 */
@Composable
fun DeliveryGlyph(
    mark: DeliveryMark,
    modifier: Modifier = Modifier,
    tint: Color = CentyTheme.tokens.textDim,
    /** Draw the first state in (a message that just landed); otherwise it starts drawn. */
    drawIn: Boolean = false
) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val haptics = rememberHaptics()
    val description = stringResource(deliveryLabel(mark))

    var shown by remember { mutableStateOf(mark) }
    var previous by remember { mutableStateOf<DeliveryMark?>(null) }
    val draw = remember { Animatable(if (drawIn && !reduce) 0f else 1f) }
    val shake = remember { Animatable(0f) }

    LaunchedEffect(Unit) {
        // A fresh message: the bubble lands first, then its first state draws.
        if (draw.value < 1f) {
            delay((CentyMotion.SEND * 0.6f).toLong())
            draw.animateTo(1f, tween(CentyMotion.GLYPH_DRAW, easing = CentyMotion.EaseOut))
        }
    }
    LaunchedEffect(mark) {
        if (mark == shown) return@LaunchedEffect
        val from = shown
        shown = mark
        if (mark == DeliveryMark.FAILED) haptics.reject()
        if (reduce) {
            previous = null
            draw.snapTo(1f)
            return@LaunchedEffect
        }
        previous = from
        draw.snapTo(0f)
        if (mark == DeliveryMark.FAILED) {
            launch {
                shake.snapTo(0f)
                shake.animateTo(1f, tween(CentyMotion.SHAKE, easing = LinearEasing))
            }
        }
        draw.animateTo(1f, tween(CentyMotion.GLYPH_DRAW, easing = CentyMotion.EaseOut))
        previous = null
    }

    val colors = GlyphColors(tint = tint, read = tokens.accentText, failed = tokens.dangerText)
    Box(
        modifier
            .size(16.dp)
            .testTag("delivery-glyph")
            .semantics { contentDescription = description }
            .graphicsLayer {
                // One 4dp shake that dies out: sin over one and a half periods, decaying.
                val t = shake.value
                translationX = if (t in 0.001f..0.999f) 4.dp.toPx() * sin(t * 3f * PI.toFloat()) * (1f - t) else 0f
            }
            .drawWithCache {
                val unit = size.minDimension / 16f
                val glyphs = DeliveryMark.entries.associateWith { glyphPaths(it, unit) }
                val lengths = glyphs.mapValues { (_, paths) -> paths.map { PathMeasure().apply { setPath(it, false) }.length } }
                val measure = PathMeasure()
                val segment = Path()
                val stroke = Stroke(width = 1.6.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
                onDrawBehind {
                    val p = draw.value
                    previous?.let { prev ->
                        val alpha = 1f - p
                        glyphs.getValue(prev).forEach { drawPath(it, colors.of(prev), alpha = alpha, style = stroke) }
                    }
                    val current = shown
                    val paths = glyphs.getValue(current)
                    val color = colors.of(current)
                    if (p >= 1f) {
                        paths.forEach { drawPath(it, color, style = stroke) }
                    } else {
                        // Stroke-draw across the glyph's contours in order.
                        val total = lengths.getValue(current).sum()
                        var remaining = total * p
                        paths.forEachIndexed { i, path ->
                            if (remaining <= 0f) return@forEachIndexed
                            val length = lengths.getValue(current)[i]
                            if (remaining >= length) {
                                drawPath(path, color, style = stroke)
                            } else {
                                segment.reset()
                                measure.setPath(path, false)
                                measure.getSegment(0f, remaining, segment, true)
                                drawPath(segment, color, style = stroke)
                            }
                            remaining -= length
                        }
                    }
                }
            }
    )
}

private class GlyphColors(val tint: Color, val read: Color, val failed: Color) {
    fun of(mark: DeliveryMark): Color = when (mark) {
        DeliveryMark.READ -> read
        DeliveryMark.FAILED -> failed
        else -> tint
    }
}

/** Glyph geometry on a 16-unit grid, one path per contour (drawn in this order). */
private fun glyphPaths(mark: DeliveryMark, u: Float): List<Path> {
    fun path(vararg points: Float) = Path().apply {
        moveTo(points[0] * u, points[1] * u)
        var i = 2
        while (i < points.size) {
            lineTo(points[i] * u, points[i + 1] * u)
            i += 2
        }
    }
    fun arc(start: Float, sweep: Float, radius: Float = 6.2f) = Path().apply {
        arcTo(Rect(Offset(8f * u, 8f * u), radius * u), start, sweep, forceMoveTo = true)
    }
    val hands = path(8f, 4.6f, 8f, 8f, 10.6f, 9.6f)
    return when (mark) {
        DeliveryMark.QUEUED -> listOf(arc(-90f, 359.9f), hands)
        // Sending: the clock's ring is three quarters drawn: on its way, nothing loops.
        DeliveryMark.SENDING -> listOf(arc(-90f, 270f), hands)
        DeliveryMark.SENT -> listOf(path(3f, 8.6f, 6.4f, 12f, 13f, 4.8f))
        DeliveryMark.DELIVERED, DeliveryMark.READ -> listOf(
            path(0.8f, 8.6f, 4.2f, 12f, 10.8f, 4.8f),
            path(7.4f, 11.2f, 8.2f, 12f, 14.8f, 4.8f)
        )
        // ⟲: an open ring with the arrowhead at its leading end.
        DeliveryMark.FAILED -> listOf(arc(-60f, -300f, radius = 5.6f), path(11.4f, 9.4f, 13.6f, 7.2f, 15.8f, 9.4f))
    }
}
