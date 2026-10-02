package com.openmychat.mobile.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.clickable
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.features.call.AudioLevel
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion

/*
 * CallStage (UI layer v2): the dark full-screen call is assembled from these pieces — a breathing
 * ring around the avatar while ringing, a live five-bar level meter from the peer's audio RMS, and
 * 64dp circular controls.
 */

/**
 * Incoming/outgoing: a ring breathes around the avatar (1 → 1.08, 1.6 s). The loop exists only while
 * [breathing]; with reduce motion the ring is still. Values are read in the layer, so nothing
 * recomposes.
 */
@Composable
fun BreathingRing(breathing: Boolean, modifier: Modifier = Modifier, size: Dp = 120.dp, content: @Composable () -> Unit) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val animate = breathing && !reduce
    val scale: State<Float>? = if (animate) {
        rememberInfiniteTransition(label = "breath").animateFloat(
            initialValue = 1f,
            targetValue = 1.08f,
            animationSpec = infiniteRepeatable(tween(CentyMotion.BREATH, easing = CentyMotion.EaseOut), RepeatMode.Reverse),
            label = "ring"
        )
    } else null
    val ringColor by animateColorAsState(
        if (breathing) tokens.primaryLine else Color.Transparent,
        CentyMotion.slow(),
        label = "ring-color"
    )
    Box(modifier.size(size + 40.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(size + 24.dp)
                .graphicsLayer {
                    val s = scale?.value ?: 1f
                    scaleX = s
                    scaleY = s
                }
                .border(2.dp, ringColor, CircleShape)
        )
        content()
    }
}

/**
 * Five bars lit by the peer's voice level (0..1 RMS). Read through [level] in the draw phase: the
 * meter follows audio frames without recomposing.
 */
@Composable
fun LevelMeter(level: () -> Float, modifier: Modifier = Modifier, bars: Int = 5, active: Boolean = true) {
    val tokens = CentyTheme.tokens
    val lit = tokens.accentText
    val unlit = tokens.textDim.copy(alpha = 0.35f)
    val label = stringResource(R.string.call_level_meter)
    Box(
        modifier
            .size(width = (bars * 6 + (bars - 1) * 4).dp, height = 22.dp)
            .testTag("level-meter")
            .clearAndSetSemantics { contentDescription = label }
            .drawBehind {
                val on = if (active) AudioLevel.litBars(level(), bars) else 0
                val barWidth = 6.dp.toPx()
                val gap = 4.dp.toPx()
                val radius = CornerRadius(barWidth / 2, barWidth / 2)
                for (i in 0 until bars) {
                    val fraction = 0.36f + 0.64f * (i + 1) / bars
                    val h = size.height * fraction
                    drawRoundRect(
                        color = if (i < on) lit else unlit,
                        topLeft = Offset(i * (barWidth + gap), size.height - h),
                        size = Size(barWidth, h),
                        cornerRadius = radius
                    )
                }
            }
    )
}

/** A 64dp round call control with its label under it; the whole column is one target, read once. */
@Composable
fun CallControl(icon: ImageVector, label: String, container: Color, content: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier.clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
    ) {
        Box(
            Modifier.size(64.dp).clip(CircleShape).background(container).indication(interaction, ripple(color = content)),
            contentAlignment = Alignment.Center
        ) { Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(30.dp)) }
        Spacer(Modifier.size(8.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = CentyTheme.tokens.textSecondary, textAlign = TextAlign.Center)
    }
}

/** Mute / speaker: a switch (Role.Switch) whose name is the visible label and whose state is spoken. */
@Composable
fun CallToggle(icon: ImageVector, label: String, state: String, active: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    val container by animateColorAsState(if (active) tokens.textStrong else tokens.elevated, CentyMotion.base(), label = "toggle-bg")
    val content by animateColorAsState(if (active) tokens.frame else tokens.textStrong, CentyMotion.base(), label = "toggle-fg")
    val interaction = remember { MutableInteractionSource() }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .toggleable(value = active, interactionSource = interaction, indication = null, role = Role.Switch, onValueChange = { onClick() })
            .semantics { stateDescription = state }
    ) {
        Box(
            Modifier.size(64.dp).clip(CircleShape).background(container).indication(interaction, ripple(color = content)),
            contentAlignment = Alignment.Center
        ) { Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(28.dp)) }
        Spacer(Modifier.size(8.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = tokens.textSecondary, textAlign = TextAlign.Center)
    }
}
