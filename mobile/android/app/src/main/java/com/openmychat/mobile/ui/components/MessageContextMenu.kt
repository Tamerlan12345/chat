package com.openmychat.mobile.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Reply
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlin.math.roundToInt

/** Actions of the message menu, in the brief's order. */
enum class MessageAction { REPLY, COPY, EDIT, DELETE, REPORT }

/** A bubble lifted over the scrim while its menu is open. */
class LiftedMessage(
    val key: Any,
    /** Bounds of the bubble in root coordinates when it was pressed. */
    val bounds: Rect,
    val actions: List<MessageAction>,
    val onAction: (MessageAction) -> Unit,
    /** Draws the bubble again (without interaction) on the overlay. */
    val content: @Composable () -> Unit
)

/** Which bubble is lifted. One at a time. */
@Stable
class MessageMenuState {
    var lifted by mutableStateOf<LiftedMessage?>(null)
        private set

    /** True while the menu is open or closing; the bubble in the list hides under its copy. */
    fun isLifted(key: Any): Boolean = lifted?.key == key

    fun open(message: LiftedMessage) {
        lifted = message
    }

    internal fun clear() {
        lifted = null
    }
}

@Composable
fun rememberMessageMenuState(): MessageMenuState = remember { MessageMenuState() }

/**
 * Hosts the long-press menu (UI layer v2): the pressed bubble lifts (scale 1.03) over a scrim and an
 * anchored Material menu offers Ответить / Копировать / Редактировать / Удалить. Back, a tap outside or a
 * choice closes it. Reduce motion: no lift, the scrim fades. Wrap the whole screen so the scrim
 * covers the bars too.
 */
@Composable
fun MessageMenuHost(state: MessageMenuState, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    var origin by remember { mutableStateOf(Offset.Zero) }
    Box(modifier.onGloballyPositioned { origin = it.positionInRoot() }) {
        content()
        val lifted = state.lifted
        if (lifted != null) LiftedOverlay(lifted, origin, onClosed = state::clear)
    }
}

@Composable
private fun LiftedOverlay(lifted: LiftedMessage, origin: Offset, onClosed: () -> Unit) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val density = LocalDensity.current
    val progress = remember(lifted) { Animatable(0f) }
    var open by remember(lifted) { mutableStateOf(true) }
    var chosen by remember(lifted) { mutableStateOf<MessageAction?>(null) }

    LaunchedEffect(lifted, open) {
        if (open) {
            progress.animateTo(1f, tween(if (reduce) CentyMotion.FAST else CentyMotion.BASE, easing = CentyMotion.EaseOut))
        } else {
            progress.animateTo(0f, tween(CentyMotion.FAST, easing = CentyMotion.EaseOut))
            // The bubble settles back first, then the choice runs (a delete asks for confirmation).
            chosen?.let(lifted.onAction)
            onClosed()
        }
    }
    BackHandler(enabled = open) { open = false }

    Box(
        Modifier
            .fillMaxSize()
            .testTag("message-menu-scrim")
            .graphicsLayer { alpha = progress.value }
            .background(tokens.scrim)
            .pointerInput(lifted) { detectTapGestures { open = false } }
    )
    val bounds = lifted.bounds
    Box(
        Modifier
            .offset { IntOffset((bounds.left - origin.x).roundToInt(), (bounds.top - origin.y).roundToInt()) }
            .size(with(density) { bounds.width.toDp() }, with(density) { bounds.height.toDp() })
            .graphicsLayer {
                if (!reduce) {
                    val s = 1f + 0.03f * progress.value
                    scaleX = s
                    scaleY = s
                    transformOrigin = TransformOrigin.Center
                }
            }
    ) {
        lifted.content()
    }
    // The menu anchors to a box 8dp larger than the bubble on each side, so it keeps 8dp from the
    // bubble whether it opens below or above it.
    val gap = with(density) { 8.dp.roundToPx() }
    Box(
        Modifier
            .offset { IntOffset((bounds.left - origin.x).roundToInt(), (bounds.top - origin.y).roundToInt() - gap) }
            .size(with(density) { bounds.width.toDp() }, with(density) { bounds.height.toDp() } + 16.dp)
    ) {
        MessageContextMenu(
            expanded = open,
            actions = lifted.actions,
            onAction = { action ->
                chosen = action
                open = false
            },
            onDismiss = { open = false }
        )
    }
}

/** The anchored Material menu with the message actions. */
@Composable
fun MessageContextMenu(
    expanded: Boolean,
    actions: List<MessageAction>,
    onAction: (MessageAction) -> Unit,
    onDismiss: () -> Unit
) {
    val tokens = CentyTheme.tokens
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        containerColor = tokens.elevated,
        shape = RoundedCornerShape(CentyRadius.card)
    ) {
        actions.forEach { action ->
            val danger = action == MessageAction.DELETE
            val color = if (danger) tokens.dangerText else tokens.textMain
            DropdownMenuItem(
                text = { Text(stringResource(action.label), color = color) },
                leadingIcon = { Icon(action.icon, contentDescription = null, tint = if (danger) tokens.dangerText else tokens.textSecondary) },
                onClick = { onAction(action) },
                modifier = Modifier.testTag("menu-${action.name.lowercase()}")
            )
        }
    }
}

val MessageAction.label: Int
    get() = when (this) {
        MessageAction.REPLY -> R.string.action_reply
        MessageAction.COPY -> R.string.action_copy
        MessageAction.EDIT -> R.string.action_edit
        MessageAction.DELETE -> R.string.action_delete
        MessageAction.REPORT -> R.string.safety_report
    }

private val MessageAction.icon
    get() = when (this) {
        MessageAction.REPLY -> Icons.AutoMirrored.Outlined.Reply
        MessageAction.COPY -> Icons.Outlined.ContentCopy
        MessageAction.EDIT -> Icons.Outlined.Edit
        MessageAction.DELETE -> Icons.Outlined.Delete
        MessageAction.REPORT -> Icons.Outlined.Flag
    }
