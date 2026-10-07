package com.openmychat.mobile.features.chat

import android.content.res.Resources
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
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalResources
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
import com.openmychat.mobile.features.attachments.Attachments
import com.openmychat.mobile.features.attachments.MessageAttachmentView
import com.openmychat.mobile.ui.components.BubbleContour
import com.openmychat.mobile.ui.components.BubbleMeta
import com.openmychat.mobile.ui.components.DeliveryMark
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
import com.openmychat.mobile.ui.theme.CentySpace
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.launch

/**
 * One message row: the grouped bubble, its entrance, swipe-to-reply and the long-press lift.
 *
 * Entrances (see the motion table in [CentyMotion]): a fresh own bubble whose text travels from the
 * composer ([LandingOverlay]) stays hidden under it and appears as it lands, then its delivery glyph
 * draws in. Every other fresh bubble — incoming, sent from another device, or own text too long to
 * travel — fades in while rising 8 dp ([CentyMotion.INCOMING]). Reduce motion: a 120 ms fade, no
 * rise. Values are read in the layer only.
 *
 * Within a group, a bubble overlaps the one above it by its hairline and the shared edge is painted
 * over ([BubbleContour]), so the group has one contour. Groups are 8 dp apart.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ChatBubbleRow(
    item: ChatItem.Bubble,
    strings: ChatRowStrings,
    showSenderName: Boolean,
    fresh: Boolean,
    actions: ChatActions,
    menuState: MessageMenuState,
    landing: LandingState,
    onReply: (Message) -> Unit,
    onEdit: (Message) -> Unit,
    onRequestDelete: (Message) -> Unit,
    modifier: Modifier = Modifier,
    /** The touching neighbours in this group, for the one-contour outline; null outside the list. */
    contour: BubbleContour? = null,
    /** This bubble's measured width, for its neighbours' contour. */
    onWidth: (Int) -> Unit = {}
) {
    val message = item.message
    val isOwn = item.isOwn
    val reduce = LocalReduceMotion.current
    val clipboard = LocalClipboardManager.current
    val snackbar = LocalSnackbarHostState.current
    val scope = rememberCoroutineScope()
    val failed = item.mark == DeliveryMark.FAILED
    // Still in the queue: no server id yet to answer, edit or report.
    val unsent = item.mark == DeliveryMark.QUEUED || item.mark == DeliveryMark.SENDING

    // The bubble that receives the travelling composer text skips its own entrance.
    val carried = remember(item.key) { fresh && isOwn && !reduce && landing.claim(item.key, message) }
    val progress = remember { Animatable(if (fresh && !carried) 0f else 1f) }
    LaunchedEffect(Unit) {
        if (fresh && !carried) {
            progress.animateTo(
                1f,
                when {
                    reduce -> tween(CentyMotion.FAST)
                    else -> tween(CentyMotion.INCOMING, easing = CentyMotion.EaseOut)
                }
            )
        }
    }
    // Without a flight (sent elsewhere, or too long to travel) an own bubble fades and rises 8 dp like an incoming one.
    val rise = with(LocalDensity.current) { 8.dp.toPx() }

    val time = remember(message.createdAt) { DateTimeUtils.formatTime(message.createdAt) }
    val body = if (message.isDeleted) strings.deleted else message.text
    val reply = message.metadata?.replyText?.takeIf { it.isNotBlank() }?.let { ReplyPreview(message.metadata.replySenderName, it) }
    val edited = !message.updatedAt.isNullOrBlank() && !message.isDeleted
    val meta = if (item.showsMeta) BubbleMeta(time = time, edited = edited, mark = item.mark, drawMarkIn = fresh && isOwn) else null
    val senderName = if (showSenderName) message.senderName else null
    val attachment = remember(message) { Attachments.of(message) }
    val fileSize = attachment?.size?.let { formatBytes(it) }
    // Read here, in composition: a download that moves on redraws this row.
    val transfer = attachment?.fileId?.let(actions::transfer)
    val thumbnail = attachment?.let(actions::thumbnailUrl)

    // Draws the bubble without interaction: in the list (with its group contour), and again lifted
    // over the menu scrim (alone, fully outlined). The middle modifier is the attachment's own tap
    // (open) and long press (menu).
    val bubble: @Composable (Modifier, Modifier, Modifier, BubbleContour?) -> Unit = { outer, tile, surface, groupContour ->
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
            failureReason = message.failureReason,
            onRetry = { actions.onRetrySend(message) },
            onDiscard = { onRequestDelete(message) },
            contour = groupContour,
            attachment = attachment?.let { file ->
                {
                    MessageAttachmentView(
                        attachment = file,
                        upload = message.upload,
                        transfer = transfer,
                        thumbnailUrl = thumbnail,
                        sizeLabel = fileSize,
                        modifier = tile,
                        onCancelUpload = { actions.onCancelUpload(message) }
                    )
                }
            }
        )
    }

    val latestBubble = rememberUpdatedState(bubble)
    val coordinates = remember { arrayOfNulls<LayoutCoordinates>(1) }
    fun perform(action: MessageAction) {
        when (action) {
            MessageAction.REPLY -> onReply(message)
            MessageAction.COPY -> {
                clipboard.setText(AnnotatedString(message.text))
                // Android 13+ confirms copies itself.
                if (Build.VERSION.SDK_INT < 33) scope.launch { snackbar.showSnackbar(strings.copied) }
            }
            MessageAction.EDIT -> onEdit(message)
            // Both ask first: a sent message is deleted for everyone, an unsent one is never sent.
            MessageAction.DELETE -> onRequestDelete(message)
            MessageAction.REPORT -> actions.onReportMessage(message)
        }
    }
    fun menuActions() = MessageMenuPolicy.actionsFor(
        message, actions.canEdit(message), actions.canDelete(message), failed, canReport = actions.canReport(message), unsent = unsent
    )
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
                    // Reads the row's latest bubble, so a status that changes while the menu is
                    // open shows on the lifted copy too.
                    content = { latestBubble.value(Modifier, Modifier, Modifier, null) }
                )
            )
        }
    }
    val canReply = !message.isDeleted && !failed && !unsent
    // QA D4: a tap on the file opens it; the long press keeps the menu.
    val openLabel = attachment?.let {
        stringResource(if (it.isImage) R.string.attachment_open_image else R.string.attachment_open, it.name)
    }
    val tileModifier = if (attachment == null) Modifier else Modifier.combinedClickable(
        onClick = { actions.onOpenAttachment(message) },
        onClickLabel = openLabel,
        onLongClick = openMenu,
        onLongClickLabel = strings.actions
    )
    val hairline = with(LocalDensity.current) { 1.dp.roundToPx() }
    val textInset = with(LocalDensity.current) { Offset(12.dp.toPx(), 7.dp.toPx()) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .then(
                if (item.startsGroup) {
                    Modifier.padding(top = CentySpace.chatGroupGap)
                } else {
                    // Overlap the bubble above by the hairline: one shared edge, not two.
                    Modifier.layout { measurable, constraints ->
                        val placeable = measurable.measure(constraints)
                        layout(placeable.width, (placeable.height - hairline).coerceAtLeast(0)) { placeable.place(0, -hairline) }
                    }
                }
            ),
        horizontalArrangement = if (isOwn) Arrangement.End else Arrangement.Start
    ) {
        Box(Modifier.widthIn(max = 320.dp).fillMaxWidth(0.84f), contentAlignment = if (isOwn) Alignment.CenterEnd else Alignment.CenterStart) {
            SwipeToReply(onReply = { onReply(message) }, enabled = canReply) {
                bubble(
                    Modifier.graphicsLayer {
                        val p = progress.value
                        // Hidden under its own lifted copy while the menu is open, and under the
                        // travelling composer text until it lands.
                        alpha = if (menuState.isLifted(item.key) || landing.hides(item.key)) 0f else p
                        if (!reduce && p < 1f) {
                            translationY = (1f - p) * rise
                        }
                    },
                    tileModifier,
                    Modifier
                        // Kept for the long press only; onPlaced is cheap where onGloballyPositioned
                        // would dispatch on every scroll frame.
                        .onPlaced {
                            coordinates[0] = it
                            if (carried) landing.aim(item.key, it.positionInRoot() + textInset)
                        }
                        .onSizeChanged { onWidth(it.width) }
                        // A tap opens the same menu as a long press, so TalkBack's click is a real
                        // action; combinedClickable performs the long-press haptic itself.
                        .combinedClickable(
                            onClick = openMenu,
                            onClickLabel = strings.actions,
                            onLongClick = openMenu,
                            onLongClickLabel = strings.actions
                        )
                        .semantics(mergeDescendants = true) {
                            // Formatted only when accessibility asks, not on every composition.
                            contentDescription = strings.describe(
                                sender = if (isOwn) strings.fromYou else message.senderName,
                                time = time,
                                body = body,
                                mark = item.mark
                            )
                            customActions = menuActions().map { action ->
                                CustomAccessibilityAction(strings.action(action)) { perform(action); true }
                            }
                        },
                    contour
                )
            }
        }
    }
}

/**
 * Text every bubble row needs, resolved once per list instead of once per row (row composition is
 * on the critical path of the inbox → chat transition).
 */
@Stable
internal class ChatRowStrings(private val resources: Resources) {
    val deleted: String = resources.getString(R.string.chat_deleted)
    val fromYou: String = resources.getString(R.string.chat_from_you)
    val copied: String = resources.getString(R.string.chat_copied)
    val actions: String = resources.getString(R.string.chat_message_actions)
    private val actionLabels = MessageAction.entries.map { resources.getString(it.label) }
    private val markLabels = DeliveryMark.entries.map { resources.getString(deliveryLabel(it)) }

    fun action(action: MessageAction): String = actionLabels[action.ordinal]

    fun describe(sender: String, time: String, body: String, mark: DeliveryMark?): String =
        resources.getString(R.string.chat_message_description, sender, time, body) + (mark?.let { ", " + markLabels[it.ordinal] } ?: "")
}

@Composable
internal fun rememberChatRowStrings(): ChatRowStrings {
    val resources = LocalResources.current
    val configuration = LocalConfiguration.current
    return remember(resources, configuration) { ChatRowStrings(resources) }
}

@Composable
internal fun formatBytes(bytes: Long): String = when {
    bytes < 1024 -> stringResource(R.string.file_size_bytes, bytes)
    bytes < 1024 * 1024 -> stringResource(R.string.file_size_kb, bytes / 1024.0)
    else -> stringResource(R.string.file_size_mb, bytes / (1024.0 * 1024))
}
