package com.openmychat.mobile.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion

/**
 * «Ознакомлен» (UI layer v2 delight: the stamp). A primary button; once the server confirms, it turns
 * into the success state in place and the check *draws in*. The success haptic is the caller's (it
 * fires on the server's answer, not on the tap). Reduce motion: the check is simply there.
 */
@Composable
fun AcknowledgeButton(
    acknowledged: Boolean,
    busy: Boolean,
    onAcknowledge: () -> Unit,
    modifier: Modifier = Modifier
) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val shape = RoundedCornerShape(CentyRadius.control)
    AnimatedContent(
        targetState = acknowledged,
        modifier = modifier,
        transitionSpec = {
            if (reduce) fadeIn(CentyMotion.fast()) togetherWith fadeOut(CentyMotion.fast())
            else (fadeIn(CentyMotion.base()) + scaleIn(CentyMotion.base(), initialScale = 0.96f)) togetherWith fadeOut(CentyMotion.fast())
        },
        label = "acknowledge"
    ) { done ->
        if (done) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp)
                    .background(tokens.successSoft, shape)
                    .border(1.dp, tokens.successLine, shape)
                    .testTag("acknowledged")
                    .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically
            ) {
                DrawnCheck(color = tokens.success, animate = !reduce, modifier = Modifier.size(20.dp))
                Spacer(Modifier.size(8.dp))
                Text(stringResource(R.string.announcements_acknowledged), style = MaterialTheme.typography.labelLarge, color = tokens.successText)
            }
        } else {
            Button(
                onClick = onAcknowledge,
                enabled = !busy,
                shape = shape,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("acknowledge")
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = tokens.textDim)
                } else {
                    Text(stringResource(R.string.announcements_acknowledge))
                }
            }
        }
    }
}

/** A check in a ring that draws itself (ring first, then the tick), 280 ms. */
@Composable
fun DrawnCheck(color: Color, modifier: Modifier = Modifier, animate: Boolean = true) {
    val progress = remember { Animatable(if (animate) 0f else 1f) }
    LaunchedEffect(Unit) {
        if (animate) progress.animateTo(1f, tween(CentyMotion.STAMP, easing = CentyMotion.EaseOutExpo))
    }
    Box(
        modifier.drawWithCache {
            val u = size.minDimension / 20f
            val ring = Path().apply { addOval(androidx.compose.ui.geometry.Rect(10f * u - 8.5f * u, 10f * u - 8.5f * u, 10f * u + 8.5f * u, 10f * u + 8.5f * u)) }
            val tick = Path().apply {
                moveTo(6f * u, 10.4f * u)
                lineTo(8.8f * u, 13.2f * u)
                lineTo(14.2f * u, 7.4f * u)
            }
            val ringLength = PathMeasure().apply { setPath(ring, false) }.length
            val tickLength = PathMeasure().apply { setPath(tick, false) }.length
            val measure = PathMeasure()
            val segment = Path()
            val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
            onDrawBehind {
                val p = progress.value
                val total = ringLength + tickLength
                val drawn = total * p
                if (drawn >= ringLength) {
                    drawPath(ring, color, style = stroke)
                    val t = drawn - ringLength
                    if (t >= tickLength) {
                        drawPath(tick, color, style = stroke)
                    } else if (t > 0f) {
                        segment.reset()
                        measure.setPath(tick, false)
                        measure.getSegment(0f, t, segment, true)
                        drawPath(segment, color, style = stroke)
                    }
                } else if (drawn > 0f) {
                    segment.reset()
                    measure.setPath(ring, false)
                    measure.getSegment(0f, drawn, segment, true)
                    drawPath(segment, color, style = stroke)
                }
            }
        }
    )
}
