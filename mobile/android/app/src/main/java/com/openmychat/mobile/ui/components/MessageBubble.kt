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
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.AlignmentLine
import androidx.compose.ui.layout.FirstBaseline
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
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

/**
 * The neighbours a bubble shares its contour with, inside one group: their measured widths (px), or
 * null where the bubble has no touching neighbour on that side (a group edge, a failed message with
 * its «Повторить / Удалить» row in between, or a width not measured yet). Read in the draw phase.
 */
@Stable
class BubbleContour(val aboveWidth: () -> Int?, val belowWidth: () -> Int?)

/**
 * One contour per group (polish pass, rule 7): the bubbles of a group touch (overlapping by the
 * hairline) and the edge they share is painted over with the fill, so no line runs between them.
 * Where one is wider, its edge stays visible beyond the other: the contour steps. Where the edges
 * line up (the sender side always; the free side when both bubbles are equally wide, e.g. two
 * wrapped messages) the corners at the join are squared, so the side runs as one straight line
 * instead of pinching in. Drawn outside the bubble's clip, so it must come before `clip` in the chain.
 */
private fun Modifier.groupContour(
    contour: BubbleContour?,
    own: Boolean,
    position: BubblePosition,
    fill: Color,
    outline: Color,
    free: Dp,
    joined: Dp
): Modifier = if (contour == null) this else drawWithContent {
    drawContent()
    val stroke = 1.dp.toPx()
    val w = size.width
    val h = size.height
    // Squares the corner of side [atStart] at the join ([top] or bottom edge): fill over the arc,
    // then the straight outline it replaces.
    fun square(radius: Float, atStart: Boolean, top: Boolean) {
        val x = if (atStart) 0f else w - radius
        val y = if (top) 0f else h - radius
        drawRect(fill, topLeft = Offset(x, y), size = Size(radius, radius))
        drawRect(outline, topLeft = Offset(if (atStart) 0f else w - stroke, y), size = Size(stroke, radius))
    }
    fun erase(neighbor: Int?, top: Boolean) {
        if (neighbor == null || neighbor <= 0) return
        val overlap = minOf(w, neighbor.toFloat())
        val freeEdgeAligned = kotlin.math.abs(neighbor - w) < 1.5f
        // Own bubbles hang from the end, incoming ones from the start.
        val (from, to) = if (own) {
            (if (freeEdgeAligned) stroke else w - overlap + free.toPx()) to (w - stroke)
        } else {
            stroke to (if (freeEdgeAligned) w - stroke else overlap - free.toPx())
        }
        if (to <= from) return
        // Whole pixels and one more: the antialiased edge of the stroke must not leave a faint seam.
        val band = ceil(stroke) + 1f
        drawRect(fill, topLeft = Offset(from, if (top) 0f else h - band), size = Size(to - from, band))
        // The sender side always lines up; the free side only when both bubbles are as wide.
        square(joined.toPx(), atStart = !own, top = top)
        if (freeEdgeAligned) square(free.toPx(), atStart = own, top = top)
    }
    if (!position.startsGroup) erase(contour.aboveWidth(), top = true)
    if (!position.endsGroup) erase(contour.belowWidth(), top = false)
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
 * border. Inside a group the outline runs around the group, not around each bubble ([contour]).
 * The meta sits at the end of the last text line, on its baseline, when it fits there; otherwise
 * on its own line. Interaction and semantics come through [bubbleModifier].
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
    /** Why it failed (copy-ru.md delivery.failed_with_reason); null — just «Не отправлено». */
    failureReason: String? = null,
    onRetry: (() -> Unit)? = null,
    onDiscard: (() -> Unit)? = null,
    attachment: (@Composable () -> Unit)? = null,
    /** In the list: the neighbours this bubble shares one group contour with. */
    contour: BubbleContour? = null
) {
    val tokens = CentyTheme.tokens
    val shape = bubbleShape(own, position)
    // Opaque fills: grouped bubbles overlap by a hairline so a group has one outline, and a lifted or
    // swiped bubble never shows what is behind it. Own = primary-soft / primary-line flattened on canvas.
    val container = if (own) tokens.primarySoft.compositeOver(tokens.canvas) else tokens.card
    val outline = when {
        failed -> tokens.dangerLine.compositeOver(container)
        own -> tokens.primaryLine.compositeOver(tokens.canvas)
        else -> tokens.border
    }
    // On primary-soft, textDim drops below 4.5:1 in dark; the own footer uses textSecondary.
    val metaColor = if (own) tokens.textSecondary else tokens.textDim
    Column(modifier, horizontalAlignment = if (own) Alignment.End else Alignment.Start) {
        Column(
            bubbleModifier
                .groupContour(contour, own, position, container, outline, free = CentyRadius.control, joined = CentyRadius.joined)
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
        if (failed && (onRetry != null || onDiscard != null)) FailedRow(failureReason, onRetry, onDiscard)
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
        // On the last line's baseline (polish pass, rule 7); bottom-aligned when either baseline is unknown.
        val lastBaseline = layout?.let { it.getLineBaseline(it.lineCount - 1).toInt() }
        val metaBaseline = metaPlaceable[FirstBaseline].takeIf { it != AlignmentLine.Unspecified }
        val inlineY = if (lastBaseline != null && metaBaseline != null) {
            lastBaseline - metaBaseline
        } else textPlaceable.height - metaPlaceable.height
        val height = if (inline) max(textPlaceable.height, inlineY + metaPlaceable.height) else textPlaceable.height + metaPlaceable.height
        layout(width.coerceAtLeast(constraints.minWidth), height) {
            textPlaceable.place(0, 0)
            val metaY = if (inline) inlineY.coerceAtLeast(0) else textPlaceable.height
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

/** Under a failed own message: «Не отправлено: причина · Повторить · Удалить». */
@Composable
private fun FailedRow(reason: String?, onRetry: (() -> Unit)?, onDiscard: (() -> Unit)?) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = Modifier.padding(top = 2.dp).testTag("failed-row"),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            if (reason.isNullOrBlank()) stringResource(R.string.delivery_failed) else stringResource(R.string.delivery_failed_with_reason, reason),
            style = MaterialTheme.typography.labelMedium,
            color = tokens.dangerText,
            modifier = Modifier.weight(1f, fill = false)
        )
        if (onRetry != null) {
            CentyTextButton(onClick = onRetry) { Text(stringResource(R.string.action_retry)) }
        }
        if (onDiscard != null) {
            CentyTextButton(onClick = onDiscard, contentColor = tokens.dangerText) { Text(stringResource(R.string.action_delete)) }
        }
    }
}
