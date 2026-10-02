package com.openmychat.mobile.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.rounded.Done
import androidx.compose.material.icons.rounded.DoneAll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion

/**
 * Unread counter in `primary`. Appears with a 0.6 → 1 pop (desktop `badge-pop`), the number rolls
 * up or down when it changes; "Remove animations" turns both into a short crossfade.
 */
@Composable
fun UnreadPill(count: Int, modifier: Modifier = Modifier) {
    val reduce = LocalReduceMotion.current
    var lastShown by remember { mutableIntStateOf(count) }
    if (count > 0) lastShown = count
    val description = pluralStringResource(R.plurals.unread_messages, lastShown, lastShown)
    AnimatedVisibility(
        visible = count > 0,
        modifier = modifier,
        enter = if (reduce) fadeIn(CentyMotion.fast()) else scaleIn(CentyMotion.base(), initialScale = 0.6f) + fadeIn(CentyMotion.base()),
        exit = if (reduce) fadeOut(CentyMotion.fast()) else scaleOut(CentyMotion.fast(), targetScale = 0.6f) + fadeOut(CentyMotion.fast())
    ) {
        Box(
            modifier = Modifier
                .defaultMinSize(minWidth = 20.dp, minHeight = 20.dp)
                .background(CentyTheme.tokens.primary, CircleShape)
                .padding(horizontal = 6.dp)
                .testTag("unread-pill")
                .clearAndSetSemantics { contentDescription = description },
            contentAlignment = Alignment.Center
        ) {
            AnimatedContent(
                targetState = lastShown,
                transitionSpec = {
                    if (reduce) {
                        fadeIn(CentyMotion.fast()) togetherWith fadeOut(CentyMotion.fast())
                    } else {
                        val up = targetState > initialState
                        (slideInVertically(CentyMotion.base()) { if (up) it else -it } + fadeIn(CentyMotion.base()))
                            .togetherWith(slideOutVertically(CentyMotion.fast()) { if (up) -it else it } + fadeOut(CentyMotion.fast()))
                            .using(SizeTransform(clip = true))
                    }
                },
                label = "unread-count"
            ) { value ->
                Text(
                    text = if (value > 99) "99+" else value.toString(),
                    color = Color.White,
                    style = MaterialTheme.typography.labelSmall
                )
            }
        }
    }
}

/**
 * «печатает» with a three-dot wave (desktop `typing-dots`: 1.2 s cycle, 0.2 s stagger).
 * With "Remove animations" the dots stand still.
 */
@Composable
fun TypingIndicator(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = CentyTheme.tokens.accentText,
    style: TextStyle = MaterialTheme.typography.bodyMedium
) {
    Row(
        modifier = modifier.semantics(mergeDescendants = true) { contentDescription = text },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Text(text, color = color, style = style, maxLines = 1)
        TypingDots(color = color)
    }
}

@Composable
fun TypingDots(color: Color, modifier: Modifier = Modifier, dot: Dp = 4.dp) {
    val reduce = LocalReduceMotion.current
    val transition = if (reduce) null else rememberInfiniteTransition(label = "typing")
    Row(
        modifier = modifier.padding(top = 2.dp).clearAndSetSemantics { },
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        repeat(3) { index ->
            val alpha = transition?.animateFloat(
                initialValue = 0.25f,
                targetValue = 0.25f,
                animationSpec = infiniteRepeatable(
                    animation = keyframes {
                        durationMillis = CentyMotion.TYPING_CYCLE
                        0.25f at 0
                        1f at (CentyMotion.TYPING_CYCLE * 0.3f).toInt()
                        0.25f at (CentyMotion.TYPING_CYCLE * 0.6f).toInt()
                    },
                    repeatMode = RepeatMode.Restart,
                    initialStartOffset = StartOffset(index * CentyMotion.TYPING_STAGGER)
                ),
                label = "dot-$index"
            )?.value ?: 0.6f
            Box(Modifier.size(dot).alpha(alpha).background(color, CircleShape))
        }
    }
}

/** Delivery state of an own message, in the brief's order. Queued/failed arrive with the outbox. */
enum class DeliveryMark { QUEUED, SENT, DELIVERED, READ, FAILED }

/** ⏱ → ✓ → ✓✓ → ✓✓ (accent): the glyph crossfades in 120 ms when the state changes. */
@Composable
fun DeliveryGlyph(mark: DeliveryMark, modifier: Modifier = Modifier, tint: Color = CentyTheme.tokens.textDim) {
    val tokens = CentyTheme.tokens
    val description = stringResource(
        when (mark) {
            DeliveryMark.QUEUED -> R.string.delivery_queued
            DeliveryMark.SENT -> R.string.delivery_sent
            DeliveryMark.DELIVERED -> R.string.delivery_delivered
            DeliveryMark.READ -> R.string.delivery_read
            DeliveryMark.FAILED -> R.string.delivery_failed
        }
    )
    AnimatedContent(
        targetState = mark,
        transitionSpec = { fadeIn(CentyMotion.fast()) togetherWith fadeOut(CentyMotion.fast()) },
        modifier = modifier.semantics { contentDescription = description },
        label = "delivery"
    ) { state ->
        val (icon, color) = when (state) {
            DeliveryMark.QUEUED -> Icons.Outlined.Schedule to tint
            DeliveryMark.SENT -> Icons.Rounded.Done to tint
            DeliveryMark.DELIVERED -> Icons.Rounded.DoneAll to tint
            DeliveryMark.READ -> Icons.Rounded.DoneAll to tokens.accentText
            DeliveryMark.FAILED -> Icons.Outlined.ErrorOutline to tokens.danger
        }
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(15.dp))
    }
}
