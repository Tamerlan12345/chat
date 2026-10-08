package com.openmychat.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.coerceAtLeast
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentySpace
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * Empty state: an authored spot illustration (or an icon in a soft tile), one sentence and, where
 * there is one, the next step as a tonal button that names it («Найти сотрудника», not «Обновить»).
 * The block sits in the upper third of the free space (35 %, not dead centre — polish pass, rule 4)
 * and scrolls when the text is large (fontScale 2.0), so the action stays reachable.
 */
@Composable
fun EmptyState(
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    message: String? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    illustration: Illustration? = null
) {
    val tokens = CentyTheme.tokens
    StatePanel(
        illustration = illustration,
        icon = icon,
        iconTint = tokens.accentText,
        iconBackground = tokens.primarySoft,
        title = title,
        message = message,
        modifier = modifier.testTag("empty-state"),
        action = if (actionLabel != null && onAction != null) {
            { CentyTonalButton(text = actionLabel, onClick = onAction, modifier = Modifier.testTag("empty-state-action")) }
        } else null
    )
}

/** Error state: what went wrong and «Повторить». Announced politely to TalkBack. */
@Composable
fun ErrorState(
    title: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    message: String = stringResource(R.string.error_check_connection),
    icon: ImageVector = Icons.Outlined.CloudOff,
    illustration: Illustration? = Illustration.OFFLINE
) {
    val tokens = CentyTheme.tokens
    StatePanel(
        illustration = illustration,
        icon = icon,
        iconTint = tokens.dangerText,
        iconBackground = tokens.dangerSoft,
        title = title,
        message = message,
        modifier = modifier
            .testTag("error-state")
            .semantics { liveRegion = LiveRegionMode.Polite },
        action = {
            CentyTonalButton(text = stringResource(R.string.action_retry), onClick = onRetry)
        }
    )
}

@Composable
private fun StatePanel(
    illustration: Illustration?,
    icon: ImageVector?,
    iconTint: Color,
    iconBackground: Color,
    title: String,
    message: String?,
    modifier: Modifier,
    action: (@Composable () -> Unit)?
) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        val available = maxHeight
        Layout(
            content = { StatePanelBlock(illustration, icon, iconTint, iconBackground, title, message, action) },
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = CentySpace.xxl, vertical = CentySpace.xl)
                .heightIn(min = (available - CentySpace.xl * 2).coerceAtLeast(0.dp))
        ) { measurables, constraints ->
            val block = measurables.single().measure(constraints.copy(minWidth = 0, minHeight = 0))
            val height = maxOf(constraints.minHeight, block.height)
            layout(constraints.maxWidth, height) {
                // 35 % of the free space above the block, 65 % below it.
                block.place((constraints.maxWidth - block.width) / 2, ((height - block.height) * 0.35f).toInt())
            }
        }
    }
}

@Composable
private fun StatePanelBlock(
    illustration: Illustration?,
    icon: ImageVector?,
    iconTint: Color,
    iconBackground: Color,
    title: String,
    message: String?,
    action: (@Composable () -> Unit)?
) {
    val tokens = CentyTheme.tokens
    Column(
        modifier = Modifier.widthIn(max = 360.dp).fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        if (illustration != null) {
            SpotIllustration(illustration)
            Spacer(Modifier.height(CentySpace.l))
        } else if (icon != null) {
            Box(
                modifier = Modifier
                    .size(56.dp)
                    .background(iconBackground, RoundedCornerShape(16.dp)),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(26.dp))
            }
            Spacer(Modifier.height(CentySpace.l))
        }
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            color = tokens.textStrong,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() }
        )
        if (message != null) {
            Spacer(Modifier.height(CentySpace.s))
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = tokens.textSecondary,
                textAlign = TextAlign.Center
            )
        }
        if (action != null) {
            Spacer(Modifier.height(CentySpace.xl))
            action()
        }
    }
}

/** A one-line danger notice inside a screen (e.g. a refresh failed while content stays visible). */
@Composable
fun InlineNotice(text: String, modifier: Modifier = Modifier, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(tokens.dangerSoft, RoundedCornerShape(8.dp))
            .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)
            .heightIn(min = 40.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(text, color = tokens.dangerText, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        if (actionLabel != null && onAction != null) {
            CentyTextButton(onClick = onAction) { Text(actionLabel) }
        }
    }
}
