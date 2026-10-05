package com.openmychat.mobile.features.chat

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Reply
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.ui.components.LocalSnackbarAnchor
import com.openmychat.mobile.ui.navigation.LocalBottomBarVisible
import com.openmychat.mobile.ui.navigation.NavBarInset
import androidx.compose.ui.unit.offset
import com.openmychat.mobile.ui.components.rememberHaptics
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The composer grows line by line up to six lines, then scrolls inside. */
object ComposerSizing {
    const val MAX_LINES = 6
}

private sealed interface ComposerBanner {
    val message: Message

    data class Editing(override val message: Message) : ComposerBanner
    data class Replying(override val message: Message) : ComposerBanner
}

/**
 * The composer: an L3 surface glued to the keyboard. It takes the navigation-bar and IME insets
 * itself (`WindowInsets.ime` animates with the keyboard on API 30+), so it moves frame by frame with
 * it. The field grows from one to six lines at once (a new line is never clipped) and shrinks with a
 * spring, then scrolls; the attach button (when there is one) morphs into send as text appears. On
 * send the text is handed to [LandingState]: it travels into its bubble while the placeholder comes
 * back after 120 ms.
 */
@Composable
internal fun ChatComposer(
    editingMessage: Message?,
    replyTo: Message?,
    /** The draft answers one of my own messages: «Ответ · Вы». */
    replyToIsOwn: Boolean,
    onCancelReply: () -> Unit,
    onSent: () -> Unit,
    actions: ChatActions,
    landing: LandingState? = null,
    onAttach: (() -> Unit)? = null,
    /** False while the chat is closed for sending (a block, or the server's `DM_NOT_ALLOWED`). */
    enabled: Boolean = true,
    /** Why sending is closed; inside the composer, so snackbars float above it too. */
    lockBanner: (@Composable () -> Unit)? = null
) {
    val tokens = CentyTheme.tokens
    val haptics = rememberHaptics()
    val reduce = LocalReduceMotion.current
    val anchor = LocalSnackbarAnchor.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    DisposableEffect(anchor) { onDispose { anchor.bottom = 0.dp } }
    var text by rememberSaveable { mutableStateOf("") }
    // Only a real change of the edited message replaces the text. On re-entry (after a call or a
    // tab switch) the restored id matches, so the saved draft is kept.
    var editingId by rememberSaveable { mutableStateOf<Long?>(null) }
    LaunchedEffect(editingMessage?.id) {
        val id = editingMessage?.id
        if (id != editingId) {
            editingId = id
            text = editingMessage?.text.orEmpty()
        }
    }
    // Where the typed text sits, for the landing flight; and the placeholder's return after a send.
    val textCoordinates = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val measurer = rememberTextMeasurer()
    val bodyStyle = MaterialTheme.typography.bodyLarge
    val bubbleTextWidth = with(density) { bubbleTextMaxWidth(LocalWindowInfo.current.containerSize.width.toDp()).roundToPx() }
    val placeholder = remember { Animatable(1f) }

    val canSend = enabled && text.isNotBlank()
    val send = {
        if (canSend) {
            val sent = text
            val start = textCoordinates[0]?.takeIf { it.isAttached }?.positionInRoot()
            // Only what its bubble shows in a few lines travels; a long message lands with a fade.
            val fits = measurer.measure(sent.trim(), bodyStyle, constraints = Constraints(maxWidth = bubbleTextWidth.coerceAtLeast(1))).lineCount <= LANDING_MAX_LINES
            if (!reduce && editingMessage == null && landing != null && start != null && fits) landing.launch(sent.trim(), start)
            // The text leaves the field only once the message is on disk (delivery-state.md §7.4):
            // if it could not be stored, it stays here to send again.
            actions.onSubmit(sent, if (editingMessage == null) replyTo else null) {
                if (text == sent) text = ""
                onSent()
            }
            haptics.tick()
            if (!reduce) {
                scope.launch {
                    placeholder.snapTo(0f)
                    delay(CentyMotion.FAST.toLong())
                    placeholder.animateTo(1f, tween(CentyMotion.FAST, easing = CentyMotion.EaseOut))
                }
            }
        }
    }

    val hairline = tokens.border
    Column(
        Modifier
            .fillMaxWidth()
            .background(tokens.elevated)
            .drawBehind { drawLine(hairline, Offset(0f, 0f), Offset(size.width, 0f), strokeWidth = 1.dp.toPx()) }
            .bottomBarAwareInsetsPadding()
    ) {
        Column(Modifier.onSizeChanged { anchor.bottom = with(density) { it.height.toDp() } }) {
            lockBanner?.invoke()
            val banner: ComposerBanner? = when {
                editingMessage != null -> ComposerBanner.Editing(editingMessage)
                replyTo != null -> ComposerBanner.Replying(replyTo)
                else -> null
            }
            AnimatedContent(
                targetState = banner,
                contentKey = { it?.let { b -> b::class to b.message.id } },
                transitionSpec = {
                    if (reduce) {
                        fadeIn(CentyMotion.fast()) togetherWith fadeOut(CentyMotion.fast())
                    } else {
                        (expandVertically(CentyMotion.base(), expandFrom = Alignment.Bottom) + fadeIn(CentyMotion.base()))
                            .togetherWith(shrinkVertically(CentyMotion.fast(), shrinkTowards = Alignment.Bottom) + fadeOut(CentyMotion.fast()))
                    }
                },
                label = "composer-banner"
            ) { shown ->
                when (shown) {
                    is ComposerBanner.Editing -> ComposerBannerRow(
                        icon = Icons.Outlined.Edit,
                        title = stringResource(R.string.chat_editing),
                        text = shown.message.text,
                        closeLabel = stringResource(R.string.chat_cancel_edit),
                        onClose = actions::onCancelEdit,
                        tag = "edit-banner"
                    )
                    is ComposerBanner.Replying -> ComposerBannerRow(
                        icon = Icons.AutoMirrored.Outlined.Reply,
                        title = stringResource(
                            R.string.chat_replying_to,
                            if (replyToIsOwn || shown.message.senderName.isBlank()) stringResource(R.string.chat_from_you) else shown.message.senderName
                        ),
                        text = shown.message.text,
                        closeLabel = stringResource(R.string.chat_cancel_reply),
                        onClose = onCancelReply,
                        tag = "reply-banner"
                    )
                    null -> Spacer(Modifier.fillMaxWidth())
                }
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 12.dp, end = 8.dp, top = 8.dp, bottom = 8.dp)
                    .testTag("composer"),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                val shape = RoundedCornerShape(CentyRadius.control)
                BasicTextField(
                    value = text,
                    enabled = enabled,
                    onValueChange = {
                        text = it
                        actions.onTyping(it.isNotBlank())
                    },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = tokens.textMain),
                    cursorBrush = SolidColor(tokens.accentText),
                    maxLines = ComposerSizing.MAX_LINES,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.weight(1f).testTag("composer-field"),
                    decorationBox = { inner ->
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                // Grows at once, shrinks with a spring; reduce motion steps.
                                .then(if (reduce) Modifier else Modifier.shrinkSmoothly())
                                .heightIn(min = 48.dp)
                                .background(tokens.card, shape)
                                .border(1.dp, tokens.borderStrong, shape)
                                .padding(horizontal = 12.dp, vertical = 12.dp),
                            contentAlignment = Alignment.CenterStart
                        ) {
                            if (text.isEmpty()) {
                                Text(
                                    stringResource(if (enabled) R.string.chat_composer_hint else R.string.chat_composer_unavailable),
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = tokens.textDim,
                                    modifier = Modifier.graphicsLayer { alpha = placeholder.value }
                                )
                            }
                            Box(Modifier.onPlaced { textCoordinates[0] = it }) { inner() }
                        }
                    }
                )
                ComposerAction(
                    canSend = canSend,
                    editing = editingMessage != null,
                    onSend = send,
                    onAttach = if (enabled) onAttach else null
                )
            }
        }
    }
}

/**
 * Send, or attach while the field is empty when attaching is available: the two morph with a scale
 * and crossfade (150 ms). Without attach, send waits dimmed and fills with primary when there is text.
 */
@Composable
internal fun ComposerAction(canSend: Boolean, editing: Boolean, onSend: () -> Unit, onAttach: (() -> Unit)?) {
    val reduce = LocalReduceMotion.current
    val showSend = canSend || onAttach == null || editing
    AnimatedContent(
        targetState = showSend,
        transitionSpec = {
            if (reduce) {
                fadeIn(CentyMotion.fast()) togetherWith fadeOut(CentyMotion.fast())
            } else {
                (scaleIn(CentyMotion.lift(), initialScale = 0.7f) + fadeIn(CentyMotion.lift()))
                    .togetherWith(scaleOut(CentyMotion.lift(), targetScale = 0.7f) + fadeOut(CentyMotion.lift()))
            }
        },
        label = "composer-action"
    ) { send ->
        if (send) {
            SendButton(canSend = canSend, editing = editing, onClick = onSend)
        } else {
            val tokens = CentyTheme.tokens
            IconButton(onClick = { onAttach?.invoke() }, modifier = Modifier.size(48.dp).testTag("composer-attach")) {
                Icon(Icons.Outlined.AttachFile, contentDescription = stringResource(R.string.chat_attach), tint = tokens.textSecondary)
            }
        }
    }
}

@Composable
private fun SendButton(canSend: Boolean, editing: Boolean, onClick: () -> Unit) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val container by animateColorAsState(if (canSend) tokens.primary else tokens.hover, CentyMotion.base(), label = "send-bg")
    val content by animateColorAsState(if (canSend) Color.White else tokens.textDim, CentyMotion.base(), label = "send-fg")
    val scale by animateFloatAsState(if (canSend || reduce) 1f else 0.92f, CentyMotion.base(), label = "send-scale")
    val label = stringResource(if (editing) R.string.chat_save_edit else R.string.chat_send)
    IconButton(
        onClick = onClick,
        enabled = canSend,
        modifier = Modifier
            .size(48.dp)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .background(container, RoundedCornerShape(CentyRadius.control))
            .testTag("composer-send")
    ) {
        Icon(
            imageVector = if (editing) Icons.Rounded.Check else Icons.AutoMirrored.Rounded.Send,
            contentDescription = label,
            tint = content
        )
    }
}

@Composable
private fun ComposerBannerRow(icon: ImageVector, title: String, text: String, closeLabel: String, onClose: () -> Unit, tag: String) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 4.dp, top = 4.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, contentDescription = null, tint = tokens.accentText, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        // The quote bar: the same 2dp indigo as the reply inside a bubble.
        Box(Modifier.width(2.dp).heightIn(min = 34.dp).background(tokens.primary))
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.labelLarge, color = tokens.accentText, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(text, style = MaterialTheme.typography.bodySmall, color = tokens.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = onClose) {
            Icon(Icons.Outlined.Close, contentDescription = closeLabel)
        }
    }
}

/**
 * Height follows the content at once when it grows (a new line is never clipped for a frame) and
 * eases down with a spring when it shrinks.
 */
@Composable
private fun Modifier.shrinkSmoothly(): Modifier {
    val height = remember { Animatable(-1f) }
    val scope = rememberCoroutineScope()
    return this
        .clipToBounds()
        .layout { measurable, constraints ->
            val placeable = measurable.measure(constraints)
            val target = placeable.height.toFloat()
            val current = height.value
            if (current < 0f || target > current) {
                scope.launch { height.snapTo(target) }
            } else if (target < current && height.targetValue != target) {
                scope.launch { height.animateTo(target, CentyMotion.grow()) }
            }
            val shown = if (current < 0f || target >= current) target else current
            layout(placeable.width, shown.toInt()) { placeable.place(0, 0) }
        }
}

/**
 * Bottom padding for the keyboard and the gesture bar, computed from the raw insets and the bottom
 * bar's measured visible height ([LocalBottomBarVisible]) instead of consumed insets: the navigation
 * scaffold switches its own inset consumption the moment the bar's target changes, which used to
 * drop the composer by the gesture inset on the first frame of chat → inbox. Here the composer rests
 * max(keyboard, visible bar or gesture inset) above the bottom edge and moves continuously.
 */
@Composable
private fun Modifier.bottomBarAwareInsetsPadding(): Modifier {
    val ime = WindowInsets.ime
    val nav = WindowInsets.navigationBars
    val barVisible = LocalBottomBarVisible.current
    return layout { measurable, constraints ->
        val navInset = nav.getBottom(this)
        // The bar sits below this screen, so only what it does not cover of the gesture inset is padded.
        val navPadding = navInset - NavBarInset.consumedBottom(navInset, barVisible())
        val bottom = maxOf(ime.getBottom(this), navPadding).coerceAtLeast(0)
        val placeable = measurable.measure(constraints.offset(vertical = -bottom))
        layout(placeable.width, placeable.height + bottom) { placeable.place(0, 0) }
    }
}
