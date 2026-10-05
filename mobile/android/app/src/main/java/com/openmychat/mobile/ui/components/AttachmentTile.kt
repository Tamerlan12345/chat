package com.openmychat.mobile.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.FileOpen
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion

/** Kind of attachment, for its glyph. */
enum class AttachmentKind { PDF, IMAGE, DOCUMENT, SHEET, ARCHIVE, OTHER }

fun attachmentKind(name: String, mime: String? = null): AttachmentKind {
    val ext = name.substringAfterLast('.', "").lowercase()
    return when {
        mime == "application/pdf" || ext == "pdf" -> AttachmentKind.PDF
        mime?.startsWith("image/") == true || ext in setOf("png", "jpg", "jpeg", "gif", "webp", "heic") -> AttachmentKind.IMAGE
        ext in setOf("doc", "docx", "odt", "rtf", "txt", "md") -> AttachmentKind.DOCUMENT
        ext in setOf("xls", "xlsx", "ods", "csv") -> AttachmentKind.SHEET
        ext in setOf("zip", "rar", "7z", "tar", "gz") -> AttachmentKind.ARCHIVE
        else -> AttachmentKind.OTHER
    }
}

/**
 * A file in a bubble (UI layer v2): glyph tile with the extension, name, size and an open action.
 * Upload states are drawn here for the send queue (Task 15): [progress] shows a ring, [failed] a retry.
 * [status] replaces the size line (download progress, the server's reason); [onCancel] stops an upload.
 */
@Composable
fun FileAttachmentTile(
    name: String,
    sizeLabel: String?,
    modifier: Modifier = Modifier,
    kind: AttachmentKind = attachmentKind(name),
    progress: Float? = null,
    failed: Boolean = false,
    onRetry: (() -> Unit)? = null,
    onOpen: (() -> Unit)? = null,
    status: String? = null,
    statusIsError: Boolean = false,
    onCancel: (() -> Unit)? = null
) {
    val tokens = CentyTheme.tokens
    val shape = RoundedCornerShape(CentyRadius.chip)
    val extension = name.substringAfterLast('.', "").take(4).uppercase()
    Row(
        modifier = modifier
            .widthIn(min = 200.dp)
            .clip(shape)
            // A tile is a fill inside its bubble, not another outline (polish pass, rule 1).
            .background(tokens.active)
            .padding(start = 8.dp, end = 4.dp, top = 8.dp, bottom = 8.dp)
            .testTag("attachment-file"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Box(
            Modifier
                .size(40.dp)
                .background(if (kind == AttachmentKind.PDF) tokens.dangerSoft else tokens.primarySoft, RoundedCornerShape(CentyRadius.control)),
            contentAlignment = Alignment.Center
        ) {
            if (progress != null) {
                UploadProgressRing(progress, Modifier.size(28.dp))
            } else if (extension.isNotEmpty() && kind != AttachmentKind.IMAGE) {
                Text(
                    extension,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (kind == AttachmentKind.PDF) tokens.dangerText else tokens.accentText,
                    maxLines = 1
                )
            } else {
                Icon(
                    if (kind == AttachmentKind.IMAGE) Icons.Outlined.Image else Icons.Outlined.Description,
                    contentDescription = null,
                    tint = tokens.accentText,
                    modifier = Modifier.size(22.dp)
                )
            }
        }
        Column(Modifier.weight(1f, fill = false)) {
            Text(name, style = MaterialTheme.typography.bodyMedium, color = tokens.textStrong, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                when {
                    status != null -> status
                    failed -> stringResource(R.string.attachment_failed)
                    progress != null -> stringResource(R.string.attachment_uploading, (progress * 100).toInt())
                    else -> sizeLabel ?: stringResource(R.string.chat_file)
                },
                style = MaterialTheme.typography.labelSmall,
                // textDim on the tile drops to 4.1:1 in dark; the size reads in textSecondary.
                color = if (failed || statusIsError) tokens.dangerText else tokens.textSecondary
            )
        }
        when {
            progress != null && onCancel != null -> IconButton(onClick = onCancel) {
                Icon(Icons.Rounded.Close, contentDescription = stringResource(R.string.attachment_cancel), tint = tokens.textSecondary)
            }
            failed && onRetry != null -> IconButton(onClick = onRetry) {
                Icon(Icons.Rounded.Refresh, contentDescription = stringResource(R.string.action_retry), tint = tokens.accentText)
            }
            onOpen != null && progress == null -> IconButton(onClick = onOpen) {
                Icon(Icons.Outlined.FileOpen, contentDescription = stringResource(R.string.attachment_open, name), tint = tokens.accentText)
            }
        }
    }
}

/**
 * An image in a bubble: the dominant colour (or the card tone) holds its place, the picture fades in
 * over it when [loaded], an upload ring sits on top while sending, a failed upload offers a retry.
 */
@Composable
fun ImageAttachmentTile(
    aspectRatio: Float,
    modifier: Modifier = Modifier,
    placeholder: Color = CentyTheme.tokens.active,
    loaded: Boolean = false,
    progress: Float? = null,
    failed: Boolean = false,
    onRetry: (() -> Unit)? = null,
    /** Stops the upload: the ring becomes a button with a cross. */
    onCancel: (() -> Unit)? = null,
    image: (@Composable () -> Unit)? = null
) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val shown by animateFloatAsState(if (loaded) 1f else 0f, if (reduce) CentyMotion.fast() else CentyMotion.slow(), label = "image-in")
    Box(
        modifier
            .widthIn(max = 260.dp)
            .fillMaxWidth()
            .aspectRatio(aspectRatio.coerceIn(0.5f, 2f))
            .clip(RoundedCornerShape(CentyRadius.chip))
            .background(placeholder)
            .testTag("attachment-image"),
        contentAlignment = Alignment.Center
    ) {
        if (image != null) Box(Modifier.fillMaxSize().graphicsLayer { alpha = shown }) { image() }
        if (progress != null || failed) {
            Box(Modifier.size(48.dp).background(tokens.scrim, CircleShape), contentAlignment = Alignment.Center) {
                if (failed && onRetry != null) {
                    IconButton(onClick = onRetry) {
                        Icon(Icons.Rounded.Refresh, contentDescription = stringResource(R.string.action_retry), tint = Color.White)
                    }
                } else if (progress != null && onCancel != null) {
                    IconButton(onClick = onCancel) {
                        UploadProgressRing(progress, Modifier.size(32.dp), track = Color.White.copy(alpha = 0.3f), ring = Color.White)
                        Icon(Icons.Rounded.Close, contentDescription = stringResource(R.string.attachment_cancel), tint = Color.White, modifier = Modifier.size(18.dp))
                    }
                } else if (progress != null) {
                    UploadProgressRing(progress, Modifier.size(32.dp), track = Color.White.copy(alpha = 0.3f), ring = Color.White)
                }
            }
        }
    }
}

/** Determinate upload ring. */
@Composable
fun UploadProgressRing(
    progress: Float,
    modifier: Modifier = Modifier,
    track: Color = CentyTheme.tokens.primaryLine,
    ring: Color = CentyTheme.tokens.accentText
) {
    val value = progress.coerceIn(0f, 1f)
    Box(
        modifier
            .semantics { progressBarRangeInfo = ProgressBarRangeInfo(value, 0f..1f) }
            .drawBehind {
                val stroke = 2.5.dp.toPx()
                val inset = stroke / 2
                val arcSize = Size(size.width - stroke, size.height - stroke)
                drawArc(track, 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(stroke))
                drawArc(ring, -90f, 360f * value, false, Offset(inset, inset), arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
            }
    )
}
