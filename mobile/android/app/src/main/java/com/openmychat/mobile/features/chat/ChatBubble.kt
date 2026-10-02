package com.openmychat.mobile.features.chat

import android.os.Build
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.core.util.DateTimeUtils
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import com.openmychat.mobile.ui.components.BubbleMeta
import com.openmychat.mobile.ui.components.DeliveryMark
import com.openmychat.mobile.ui.components.FileAttachmentTile
import com.openmychat.mobile.ui.components.LiftedMessage
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import com.openmychat.mobile.ui.components.MessageAction
import com.openmychat.mobile.ui.components.MessageBubble
import com.openmychat.mobile.ui.components.MessageMenuState
import com.openmychat.mobile.ui.components.ReplyPreview
import com.openmychat.mobile.ui.components.SwipeToReply
import com.openmychat.mobile.ui.components.deliveryLabel
import com.openmychat.mobile.ui.components.label
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.launch

/**
 * One message row: the grouped bubble, its entrance, swipe-to-reply and the long-press lift.
 *
 * "The message lands": a fresh own bubble rises out of the composer (24dp, scale 0.96 → 1 from its
 * bottom-end corner, 240 ms decelerate), then its delivery glyph draws in. A fresh incoming bubble
 * fades and rises 8dp. Reduce motion: a fade. Values are read in the layer only.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ChatBubbleRow(
    item: ChatItem.Bubble,
    showSenderName: Boolean,
    fresh: Boolean,
    actions: ChatActions,
    menuState: MessageMenuState,
    onReply: (Message) -> Unit,
    onEdit: (Message) -> Unit,
    onRequestDelete: (Message) -> Unit,
    modifier: Modifier = Modifier
) {
    val message = item.message
    val isOwn = item.isOwn
    val reduce = LocalReduceMotion.current
    val clipboard = LocalClipboardManager.current
    val snackbar = LocalSnackbarHostState.current
    val scope = rememberCoroutineScope()
    val copied = stringResource(R.string.chat_copied)
    val failed = item.mark == DeliveryMark.FAILED

    val progress = remember { Animatable(if (fresh) 0f else 1f) }
    LaunchedEffect(Unit) {
        if (fresh) {
            progress.animateTo(
                1f,
                when {
                    reduce -> tween(CentyMotion.FAST)
                    isOwn -> tween(CentyMotion.SEND, easing = CentyMotion.EaseOutExpo)
                    else -> tween(CentyMotion.INCOMING, easing = CentyMotion.EaseOut)
                }
            )
        }
    }
    val rise = with(LocalDensity.current) { (if (isOwn) 24.dp else 8.dp).toPx() }

    val time = remember(message.createdAt) { DateTimeUtils.formatTime(message.createdAt) }
    val sender = if (isOwn) stringResource(R.string.chat_from_you) else message.senderName
    val body = if (message.isDeleted) stringResource(R.string.chat_deleted) else message.text
    val markLabel = item.mark?.let { stringResource(deliveryLabel(it)) }
    val description = stringResource(R.string.chat_message_description, sender, time, body) + (markLabel?.let { ", $it" } ?: "")
    val reply = message.metadata?.replyText?.takeIf { it.isNotBlank() }?.let { ReplyPreview(message.metadata.replySenderName, it) }
    val edited = !message.updatedAt.isNullOrBlank() && !message.isDeleted
    val meta = if (item.showsMeta) BubbleMeta(time = time, edited = edited, mark = item.mark, drawMarkIn = fresh && isOwn) else null
    val senderName = if (showSenderName) message.senderName else null
    val fileName = message.fileOriginalName ?: message.metadata?.fileName ?: message.text
    val fileSize = message.metadata?.size?.let { formatBytes(it) }
    val isFile = message.type == MessageType.FILE && !message.isDeleted

    // Draws the bubble without interaction: in the list, and again lifted over the menu scrim.
    val bubble: @Composable (Modifier, Modifier) -> Unit = { outer, surface ->
        MessageBubble(
            own = isOwn,
            position = item.position,
            modifier = outer,
            bubbleModifier = surface,
            text = body,
            deleted = message.isDeleted,
            senderName = senderName,
            reply = reply,
            meta = meta,
            failed = failed,
            onRetry = { actions.onRetrySend(message) },
            onDiscard = { actions.onDiscardFailed(message) },
            attachment = if (isFile) {
                { FileAttachmentTile(name = fileName, sizeLabel = fileSize) }
            } else null
        )
    }

    val actionLabels = MessageAction.entries.associateWith { stringResource(it.label) }
    val coordinates = remember { arrayOfNulls<LayoutCoordinates>(1) }
    fun perform(action: MessageAction) {
        when (action) {
            MessageAction.REPLY -> onReply(message)
            MessageAction.COPY -> {
                clipboard.setText(AnnotatedString(message.text))
                // Android 13+ confirms copies itself.
                if (Build.VERSION.SDK_INT < 33) scope.launch { snackbar.showSnackbar(copied) }
            }
            MessageAction.EDIT -> onEdit(message)
            MessageAction.DELETE -> if (failed) actions.onDiscardFailed(message) else onRequestDelete(message)
        }
    }
    fun menuActions() = MessageMenuPolicy.actionsFor(message, actions.canEdit(message), actions.canDelete(message), failed)
    val openMenu = {
        val bounds = coordinates[0]?.takeIf { it.isAttached }?.boundsInRoot()
        val available = menuActions()
        if (bounds != null && available.isNotEmpty()) {
            menuState.open(
                LiftedMessage(
                    key = item.key,
                    bounds = bounds,
                    actions = available,
                    onAction = ::perform,
                    content = { bubble(Modifier, Modifier) }
                )
            )
        }
    }
    val canReply = !message.isDeleted && !failed

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = if (item.startsGroup) 10.dp else 2.dp),
        horizontalArrangement = if (isOwn) Arrangement.End else Arrangement.Start
    ) {
        Box(Modifier.widthIn(max = 320.dp).fillMaxWidth(0.84f), contentAlignment = if (isOwn) Alignment.CenterEnd else Alignment.CenterStart) {
            SwipeToReply(onReply = { onReply(message) }, enabled = canReply) {
                bubble(
                    Modifier.graphicsLayer {
                        val p = progress.value
                        // Hidden under its own lifted copy while the menu is open.
                        alpha = if (menuState.isLifted(item.key)) 0f else p
                        if (!reduce && p < 1f) {
                            translationY = (1f - p) * rise
                            val scale = if (isOwn) 0.96f + 0.04f * p else 1f
                            scaleX = scale
                            scaleY = scale
                            transformOrigin = TransformOrigin(if (isOwn) 1f else 0f, 1f)
                        }
                    },
                    Modifier
                        .onGloballyPositioned { coordinates[0] = it }
                        // A tap opens the same menu as a long press, so TalkBack's click is a real
                        // action; combinedClickable performs the long-press haptic itself.
                        .combinedClickable(
                            onClick = openMenu,
                            onClickLabel = stringResource(R.string.chat_message_actions),
                            onLongClick = openMenu,
                            onLongClickLabel = stringResource(R.string.chat_message_actions)
                        )
                        .semantics(mergeDescendants = true) {
                            contentDescription = description
                            customActions = menuActions().map { action ->
                                CustomAccessibilityAction(actionLabels.getValue(action)) { perform(action); true }
                            }
                        }
                )
            }
        }
    }
}

@Composable
private fun formatBytes(bytes: Long): String = when {
    bytes < 1024 -> stringResource(R.string.file_size_bytes, bytes)
    bytes < 1024 * 1024 -> stringResource(R.string.file_size_kb, bytes / 1024.0)
    else -> stringResource(R.string.file_size_mb, bytes / (1024.0 * 1024))
}
