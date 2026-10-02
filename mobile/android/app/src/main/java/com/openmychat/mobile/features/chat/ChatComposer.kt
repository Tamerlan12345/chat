package com.openmychat.mobile.features.chat

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
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
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.ui.components.LocalSnackbarAnchor
import com.openmychat.mobile.ui.components.rememberHaptics
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.launch

/** The composer grows line by line up to six lines, then scrolls inside. */
object ComposerSizing {
    const val MAX_LINES = 6

    fun visibleLines(lineCount: Int): Int = lineCount.coerceIn(1, MAX_LINES)

    fun scrollsInternally(lineCount: Int): Boolean = lineCount > MAX_LINES
}

private sealed interface ComposerBanner {
    val message: Message

    data class Editing(override val message: Message) : ComposerBanner
    data class Replying(override val message: Message) : ComposerBanner
}

/**
 * The composer: an L3 surface glued to the keyboard. It takes the navigation-bar and IME insets
 * itself (`WindowInsets.ime` animates with the keyboard on API 30+), so it moves frame by frame with
 * it. The field grows with a spring from one to six lines and then scrolls; the attach button (when
 * there is one) morphs into send as text appears. On send the text lifts out of the field while its
 * bubble lands in the list.
 */
@Composable
internal fun ChatComposer(
    editingMessage: Message?,
    replyTo: Message?,
    onCancelReply: () -> Unit,
    onSent: () -> Unit,
    actions: ChatActions,
    onAttach: (() -> Unit)? = null
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
    // The sent text lifting out of the field.
    var ghost by remember { mutableStateOf<String?>(null) }
    val ghostProgress = remember { Animatable(1f) }

    val canSend = text.isNotBlank()
    val send = {
        if (canSend) {
            val sent = text
            actions.onSend(sent, if (editingMessage == null) replyTo else null)
            text = ""
            onSent()
            haptics.tick()
            if (!reduce && editingMessage == null) {
                ghost = sent
                scope.launch {
                    ghostProgress.snapTo(0f)
                    ghostProgress.animateTo(1f, tween(CentyMotion.SEND, easing = CentyMotion.EaseOutExpo))
                    ghost = null
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
            .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
    ) {
        Column(Modifier.onSizeChanged { anchor.bottom = with(density) { it.height.toDp() } }) {
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
                        title = stringResource(R.string.chat_replying_to, shown.message.senderName.ifBlank { stringResource(R.string.chat_from_you) }),
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
                                // Line by line with a spring; reduce motion steps.
                                .then(if (reduce) Modifier else Modifier.animateContentSize(CentyMotion.grow()))
                                .heightIn(min = 48.dp)
                                .background(tokens.card, shape)
                                .border(1.dp, tokens.borderStrong, shape)
                                .padding(horizontal = 12.dp, vertical = 12.dp),
                            contentAlignment = Alignment.CenterStart
                        ) {
                            if (text.isEmpty()) {
                                Text(
                                    stringResource(R.string.chat_composer_hint),
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = tokens.textDim,
                                    modifier = Modifier.graphicsLayer { alpha = if (ghost != null) ghostProgress.value else 1f }
                                )
                            }
                            inner()
                            ghost?.let { sentText ->
                                Text(
                                    sentText,
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = tokens.accentText,
                                    maxLines = ComposerSizing.MAX_LINES,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.graphicsLayer {
                                        val p = ghostProgress.value
                                        alpha = 1f - p
                                        translationY = -24.dp.toPx() * p
                                    }
                                )
                            }
                        }
                    }
                )
                ComposerAction(
                    canSend = canSend,
                    editing = editingMessage != null,
                    onSend = send,
                    onAttach = onAttach
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
