package com.openmychat.mobile.ui.components

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Reply
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min

/** The swipe-to-reply rules, kept pure so they can be tested without a device. */
object SwipeToReplyMath {
    /** Past the threshold the bubble resists and never travels further than this many thresholds. */
    const val MAX_TRAVEL = 1.6f

    /**
     * Bubble offset for a finger travel of [rawDrag] px. Only a drag toward the start counts (left in
     * LTR); past [threshold] the bubble follows less and less.
     */
    fun offsetFor(rawDrag: Float, threshold: Float, rtl: Boolean): Float {
        val toward = if (rtl) max(rawDrag, 0f) else min(rawDrag, 0f)
        val distance = abs(toward)
        val travelled = if (distance <= threshold) {
            distance
        } else {
            threshold + threshold * (MAX_TRAVEL - 1f) * (1f - exp(-(distance - threshold) / threshold))
        }
        return if (rtl) travelled else -travelled
    }

    /** How full the reply arrow is, 0..1. */
    fun progress(offset: Float, threshold: Float): Float = (abs(offset) / threshold).coerceIn(0f, 1f)

    /** A release here starts a reply. */
    fun triggers(offset: Float, threshold: Float): Boolean = abs(offset) >= threshold
}

/**
 * Drag a bubble toward the start to answer it: an arrow behind it fills toward the threshold,
 * crossing it gives a light haptic tick, and releasing past it calls [onReply]. The bubble springs
 * back either way (a short tween with reduce motion). Offsets are read in the layer, never in
 * composition.
 */
@Composable
fun SwipeToReply(
    onReply: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    threshold: Dp = 64.dp,
    content: @Composable () -> Unit
) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val thresholdPx = with(LocalDensity.current) { threshold.toPx() }
    var raw by remember { mutableFloatStateOf(0f) }
    var offset by remember { mutableFloatStateOf(0f) }
    val armed = remember { BooleanArray(1) }

    val dragState = rememberDraggableState { delta ->
        raw += delta
        offset = SwipeToReplyMath.offsetFor(raw, thresholdPx, rtl)
        val crossed = SwipeToReplyMath.triggers(offset, thresholdPx)
        if (crossed && !armed[0]) haptics.tick()
        armed[0] = crossed
    }
    val ring = tokens.accentText
    val disc = tokens.primarySoft
    Box(
        modifier.draggable(
            state = dragState,
            orientation = Orientation.Horizontal,
            enabled = enabled,
            onDragStopped = {
                val reply = SwipeToReplyMath.triggers(offset, thresholdPx)
                raw = 0f
                armed[0] = false
                if (reply) onReply()
                scope.launch {
                    animate(
                        initialValue = offset,
                        targetValue = 0f,
                        animationSpec = if (reduce) tween(CentyMotion.FAST) else spring(dampingRatio = 0.8f, stiffness = Spring.StiffnessMediumLow)
                    ) { value, _ -> offset = value }
                }
            }
        )
    ) {
        // The arrow trails the bubble's end edge into the space it leaves, then waits there; it never
        // shows through a translucent own bubble.
        Box(
            Modifier
                .align(Alignment.CenterEnd)
                .padding(end = 4.dp)
                .size(32.dp)
                .testTag("swipe-reply-arrow")
                .graphicsLayer {
                    val p = SwipeToReplyMath.progress(offset, thresholdPx)
                    val trail = 40.dp.toPx()
                    translationX = if (rtl) min(offset - trail, 0f) else max(offset + trail, 0f)
                    alpha = p
                    val s = 0.6f + 0.4f * p
                    scaleX = s
                    scaleY = s
                }
                .drawBehind {
                    val p = SwipeToReplyMath.progress(offset, thresholdPx)
                    drawCircle(disc)
                    val stroke = 2.dp.toPx()
                    val inset = stroke / 2
                    drawArc(
                        color = ring,
                        startAngle = -90f,
                        sweepAngle = 360f * p,
                        useCenter = false,
                        topLeft = Offset(inset, inset),
                        size = Size(size.width - stroke, size.height - stroke),
                        style = Stroke(width = stroke)
                    )
                },
            contentAlignment = Alignment.Center
        ) {
            Icon(Icons.AutoMirrored.Rounded.Reply, contentDescription = null, tint = ring, modifier = Modifier.size(18.dp))
        }
        Box(Modifier.graphicsLayer { translationX = offset }) { content() }
    }
}
