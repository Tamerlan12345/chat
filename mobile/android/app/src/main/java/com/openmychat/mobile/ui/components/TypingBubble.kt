package com.openmychat.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * The peer is typing: an incoming bubble holding the three-dot wave (desktop `typing-dots`, 0.2 s
 * stagger). Static dots with reduce motion. The wave is drawn in the layer, so it never recomposes.
 */
@Composable
fun TypingBubble(label: String, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    val shape = bubbleShape(own = false, position = BubblePosition.SINGLE)
    Box(
        modifier
            .heightIn(min = 36.dp)
            .background(tokens.card, shape)
            .border(1.dp, tokens.border, shape)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .testTag("typing-bubble")
            .semantics {
                contentDescription = label
                liveRegion = LiveRegionMode.Polite
            },
        contentAlignment = Alignment.Center
    ) {
        TypingDots(color = tokens.textDim, dot = 7.dp, rise = 3.dp, gap = 5.dp)
    }
}
