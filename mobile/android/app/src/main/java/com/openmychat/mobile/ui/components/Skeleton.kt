package com.openmychat.mobile.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion

/** One shared sweep position for every block on screen, so the shimmer reads as one light. */
private val LocalShimmer = compositionLocalOf<State<Float>?> { null }

/**
 * Loading placeholder for lists: never a centred spinner. A slow (1.2 s) light sweep runs across
 * the blocks; with "Remove animations" the blocks stay still.
 */
@Composable
fun SkeletonContainer(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val reduce = LocalReduceMotion.current
    val progress: State<Float> = if (reduce) {
        remember { mutableFloatStateOf(-1f) }
    } else {
        rememberInfiniteTransition(label = "shimmer").animateFloat(
            initialValue = -1f,
            targetValue = 2f,
            animationSpec = infiniteRepeatable(tween(CentyMotion.SHIMMER, easing = LinearEasing), RepeatMode.Restart),
            label = "shimmer-x"
        )
    }
    val label = stringResource(R.string.loading)
    Box(
        modifier = modifier
            .testTag("skeleton")
            .semantics(mergeDescendants = true) { contentDescription = label }
    ) {
        CompositionLocalProvider(LocalShimmer provides progress) { content() }
    }
}

@Composable
fun SkeletonBlock(modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(6.dp)) {
    val tokens = CentyTheme.tokens
    val progress = LocalShimmer.current
    val highlight = if (tokens.isDark) Color.White.copy(alpha = 0.06f) else Color.White.copy(alpha = 0.7f)
    Box(
        modifier = modifier
            .background(tokens.active, shape)
            .drawWithContent {
                drawContent()
                val p = progress?.value ?: return@drawWithContent
                if (p < -0.5f) return@drawWithContent
                // The sweep is positioned in window-independent units: its own width.
                val x = size.width * p
                drawRect(
                    brush = Brush.linearGradient(
                        colors = listOf(Color.Transparent, highlight, Color.Transparent),
                        start = Offset(x - size.width * 0.6f, 0f),
                        end = Offset(x, size.height)
                    ),
                    size = size
                )
            }
    )
}

/** Inbox rows: avatar, name, preview. */
@Composable
fun ConversationSkeleton(modifier: Modifier = Modifier, rows: Int = 7, contentPadding: PaddingValues = PaddingValues()) {
    SkeletonContainer(modifier.fillMaxSize().padding(contentPadding)) {
        Column {
            repeat(rows) { index ->
                Row(
                    modifier = Modifier.fillMaxWidth().height(72.dp).padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    SkeletonBlock(Modifier.size(44.dp), CircleShape)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SkeletonBlock(Modifier.fillMaxWidth(if (index % 2 == 0) 0.45f else 0.6f).height(14.dp))
                        SkeletonBlock(Modifier.fillMaxWidth(if (index % 3 == 0) 0.8f else 0.65f).height(12.dp))
                    }
                }
            }
        }
    }
}

/** Chat history: alternating bubbles. */
@Composable
fun ChatSkeleton(modifier: Modifier = Modifier) {
    val widths = listOf(0.62f, 0.45f, 0.7f, 0.38f, 0.55f, 0.66f)
    SkeletonContainer(modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.Bottom)
        ) {
            widths.forEachIndexed { index, width ->
                val own = index % 3 == 1
                Box(Modifier.fillMaxWidth(), contentAlignment = if (own) Alignment.CenterEnd else Alignment.CenterStart) {
                    SkeletonBlock(Modifier.fillMaxWidth(width).height(if (index % 2 == 0) 52.dp else 38.dp), RoundedCornerShape(8.dp))
                }
            }
        }
    }
}

/** Announcement cards. */
@Composable
fun CardSkeleton(modifier: Modifier = Modifier, cards: Int = 4, cardHeight: Dp = 112.dp) {
    SkeletonContainer(modifier.fillMaxSize()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            repeat(cards) { SkeletonBlock(Modifier.fillMaxWidth().height(cardHeight), RoundedCornerShape(12.dp)) }
        }
    }
}
