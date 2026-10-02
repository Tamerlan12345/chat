package com.openmychat.mobile.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion

/** When «↓ N новых» shows: new messages arrived below the reader, or they are reading far up. */
object JumpToLatest {
    /** Rows below the viewport before an arrow-only button offers the way back. */
    const val SCROLLED_AWAY_ITEMS = 4

    fun isVisible(unseen: Int, itemsBelowViewport: Int): Boolean =
        itemsBelowViewport > 0 && (unseen > 0 || itemsBelowViewport >= SCROLLED_AWAY_ITEMS)
}

/**
 * Floats above the composer. With unseen messages it is the indigo signal «↓ N новых» (the number
 * rolls); otherwise a quiet L3 arrow. Scales in from 0.6 like the unread pill; reduce motion fades.
 */
@Composable
fun JumpToLatestPill(visible: Boolean, unseen: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val reduce = LocalReduceMotion.current
    var lastCount by remember { mutableIntStateOf(unseen) }
    if (unseen > 0) lastCount = unseen
    AnimatedVisibility(
        visible = visible,
        modifier = modifier,
        enter = if (reduce) fadeIn(CentyMotion.fast()) else scaleIn(CentyMotion.base(), initialScale = 0.6f) + fadeIn(CentyMotion.base()),
        exit = if (reduce) fadeOut(CentyMotion.fast()) else scaleOut(CentyMotion.fast(), targetScale = 0.6f) + fadeOut(CentyMotion.fast())
    ) {
        val tokens = CentyTheme.tokens
        val counted = unseen > 0
        val description = if (counted) {
            pluralStringResource(R.plurals.new_messages_jump, lastCount, lastCount)
        } else {
            stringResource(R.string.chat_jump_latest)
        }
        Surface(
            onClick = onClick,
            shape = CircleShape,
            color = if (counted) tokens.primary else tokens.elevated,
            contentColor = if (counted) Color.White else tokens.accentText,
            border = if (counted) null else BorderStroke(1.dp, tokens.borderStrong),
            modifier = Modifier
                .heightIn(min = 44.dp)
                .testTag("new-messages-pill")
                .semantics { contentDescription = description }
        ) {
            Row(
                modifier = Modifier.padding(start = 10.dp, end = if (counted) 14.dp else 10.dp, top = 10.dp, bottom = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Icon(Icons.Rounded.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(20.dp))
                if (counted) {
                    AnimatedContent(
                        targetState = lastCount,
                        transitionSpec = {
                            if (reduce) {
                                fadeIn(CentyMotion.fast()) togetherWith fadeOut(CentyMotion.fast())
                            } else {
                                (slideInVertically(CentyMotion.base()) { it } + fadeIn(CentyMotion.base()))
                                    .togetherWith(slideOutVertically(CentyMotion.fast()) { -it } + fadeOut(CentyMotion.fast()))
                                    .using(SizeTransform(clip = true))
                            }
                        },
                        label = "jump-count"
                    ) { count ->
                        Box { Text(pluralStringResource(R.plurals.new_messages_pill, count, count), style = MaterialTheme.typography.labelLarge) }
                    }
                }
            }
        }
    }
}
