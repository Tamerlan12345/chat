package com.openmychat.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import kotlin.math.ceil
import kotlin.math.max

/** Where a bubble sits in a run of messages from one sender. */
enum class BubblePosition {
    SINGLE, FIRST, MIDDLE, LAST;

    val startsGroup: Boolean get() = this == SINGLE || this == FIRST
    val endsGroup: Boolean get() = this == SINGLE || this == LAST
}

/**
 * Grouping radii (UI layer v2): free corners 8, the sender-side corners where two bubbles of a
 * group meet 4, and the desktop tail (2) only on the first bubble's top corner nearest the sender.
 */
fun bubbleShape(own: Boolean, position: BubblePosition): RoundedCornerShape =
    BubbleShapes[(if (own) 4 else 0) + position.ordinal]

private val BubbleShapes: List<RoundedCornerShape> = listOf(false, true).flatMap { own ->
    BubblePosition.entries.map { position ->
        val free = CentyRadius.control
        val top = if (position.startsGroup) CentyRadius.tail else CentyRadius.joined
        val bottom = if (position.endsGroup) free else CentyRadius.joined
        if (own) {
            RoundedCornerShape(topStart = free, topEnd = top, bottomEnd = bottom, bottomStart = free)
        } else {
            RoundedCornerShape(topStart = top, topEnd = free, bottomEnd = free, bottomStart = bottom)
        }
    }
}

/** A quoted message inside a bubble. */
@Immutable
data class ReplyPreview(val sender: String?, val text: String)

/** Footer of a bubble: «изменено», time and (own messages) the delivery glyph. */
@Immutable
data class BubbleMeta(
    val time: String,
    val edited: Boolean = false,
    val mark: DeliveryMark? = null,
    /** Draw the glyph in after the bubble lands (fresh own message). */
    val drawMarkIn: Boolean = false
)

/**
 * The chat bubble. Own: primary-soft fill, primary-line outline, accent text. Incoming: card and
 * border. The meta sits at the end of the last text line when it fits there, so a short message
 * stays one line tall. Interaction and semantics come through [bubbleModifier].
 *
 * A failed own message shows a row under the bubble with «Повторить» / «Удалить» (wired by the send
 * queue, Task 15).
 */
@Composable
fun MessageBubble(
    own: Boolean,
    position: BubblePosition,
    modifier: Modifier = Modifier,
    bubbleModifier: Modifier = Modifier,
    text: String? = null,
    deleted: Boolean = false,
    senderName: String? = null,
    reply: ReplyPreview? = null,
    meta: BubbleMeta? = null,
    failed: Boolean = false,
    onRetry: (() -> Unit)? = null,
    onDiscard: (() -> Unit)? = null,
    attachment: (@Composable () -> Unit)? = null
) {
    val tokens = CentyTheme.tokens
    val shape = bubbleShape(own, position)
    val container = if (own) tokens.primarySoft else tokens.card
    val outline = when {
        failed -> tokens.dangerLine
        own -> tokens.primaryLine
        else -> tokens.border
    }
    // On primary-soft, textDim drops below 4.5:1 in dark; the own footer uses textSecondary.
    val metaColor = if (own) tokens.textSecondary else tokens.textDim
    Column(modifier, horizontalAlignment = if (own) Alignment.End else Alignment.Start) {
        Column(
            bubbleModifier
                .clip(shape)
                .background(container, shape)
                .border(1.dp, outline, shape)
                .padding(horizontal = 12.dp, vertical = 7.dp)
        ) {
            if (senderName != null) {
                Text(
                    senderName,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = tokens.accentText,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(Modifier.size(2.dp))
            }
            if (reply != null && !deleted) ReplyQuote(reply)
            val metaContent: (@Composable () -> Unit)? = meta?.let { m -> { BubbleMetaRow(m, metaColor) } }
            when {
                attachment != null -> {
                    attachment()
                    if (metaContent != null) Box(Modifier.align(Alignment.End).padding(top = 4.dp)) { metaContent() }
                }
                else -> TextWithTrailingMeta(
                    text = if (deleted) stringResource(R.string.chat_deleted) else text.orEmpty(),
                    style = MaterialTheme.typography.bodyLarge,
                    color = when {
                        deleted -> tokens.textDim
                        own -> tokens.accentText
                        else -> tokens.textMain
                    },
                    fontStyle = if (deleted) FontStyle.Italic else null,
                    meta = metaContent
                )
            }
        }
        if (failed && (onRetry != null || onDiscard != null)) FailedRow(onRetry, onDiscard)
    }
}

@Composable
private fun BubbleMetaRow(meta: BubbleMeta, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (meta.edited) Text(stringResource(R.string.chat_edited), style = MaterialTheme.typography.labelSmall, color = color)
        Text(meta.time, style = MaterialTheme.typography.labelSmall, color = color)
        if (meta.mark != null) DeliveryGlyph(meta.mark, tint = color, drawIn = meta.drawMarkIn)
    }
}

/**
 * Text with the meta at the end of its last line when there is room (Telegram-style), otherwise on
 * its own line at the end. Measured in one pass; the text layout is read without recomposition.
 */
@Composable
internal fun TextWithTrailingMeta(
    text: String,
    style: TextStyle,
    color: Color,
    fontStyle: FontStyle? = null,
    meta: (@Composable () -> Unit)?
) {
    if (meta == null) {
        Text(text, style = style, color = color, fontStyle = fontStyle)
        return
    }
    val lastLayout = remember { arrayOfNulls<TextLayoutResult>(1) }
    Layout(
        content = {
            Text(text, style = style, color = color, fontStyle = fontStyle, onTextLayout = { lastLayout[0] = it })
            meta()
        }
    ) { measurables, constraints ->
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val textPlaceable = measurables[0].measure(loose)
        val metaPlaceable = measurables[1].measure(Constraints())
        val gap = 8.dp.roundToPx()
        val layout = lastLayout[0]
        val lastLineRight = layout?.let { ceil(it.getLineRight(it.lineCount - 1)).toInt() } ?: textPlaceable.width
        val maxWidth = if (constraints.hasBoundedWidth) constraints.maxWidth else Int.MAX_VALUE
        val inline = lastLineRight + gap + metaPlaceable.width <= maxWidth
        val width = if (inline) max(textPlaceable.width, lastLineRight + gap + metaPlaceable.width) else max(textPlaceable.width, metaPlaceable.width)
        val height = if (inline) max(textPlaceable.height, metaPlaceable.height) else textPlaceable.height + metaPlaceable.height
        layout(width.coerceAtLeast(constraints.minWidth), height) {
            textPlaceable.place(0, 0)
            // Bottom-aligned with the last line.
            val metaY = if (inline) height - metaPlaceable.height else textPlaceable.height
            metaPlaceable.place(width - metaPlaceable.width, metaY)
        }
    }
}

/** Reply quote inside the bubble with a 2dp indigo bar (brief). */
@Composable
fun ReplyQuote(reply: ReplyPreview, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = modifier
            .padding(bottom = 4.dp)
            .clip(RoundedCornerShape(CentyRadius.chip))
            .background(tokens.hover)
            .heightIn(min = 32.dp)
            .testTag("reply-quote")
    ) {
        Box(Modifier.width(2.dp).heightIn(min = 32.dp).background(tokens.primary))
        Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
            Text(
                reply.sender?.takeIf { it.isNotBlank() } ?: stringResource(R.string.chat_reply_to),
                style = MaterialTheme.typography.labelMedium,
                color = tokens.accentText,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(reply.text, style = MaterialTheme.typography.bodySmall, color = tokens.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Under a failed own message: «Не отправлено · Повторить · Удалить». */
@Composable
private fun FailedRow(onRetry: (() -> Unit)?, onDiscard: (() -> Unit)?) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = Modifier.padding(top = 2.dp).testTag("failed-row"),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(stringResource(R.string.delivery_failed), style = MaterialTheme.typography.labelMedium, color = tokens.dangerText)
        if (onRetry != null) {
            CentyTextButton(onClick = onRetry) { Text(stringResource(R.string.action_retry)) }
        }
        if (onDiscard != null) {
            CentyTextButton(onClick = onDiscard, contentColor = tokens.dangerText) { Text(stringResource(R.string.action_delete)) }
        }
    }
}
