package com.openmychat.mobile.features.attachments

import androidx.compose.animation.core.animate
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil3.compose.AsyncImage
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * An image attachment full screen, over everything: the server's thumbnail at once, the full picture
 * over it when downloaded. Pinch to zoom (1–5×), drag to pan, double tap to zoom in or back; at 1× a
 * swipe down closes it (so do back and «Закрыть»).
 */
@Composable
fun ImageViewer(
    attachment: MessageAttachment,
    thumbnailUrl: String?,
    transfer: TransferState?,
    onRetry: () -> Unit,
    onDismiss: () -> Unit
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)
    ) {
        ImageViewerContent(attachment, thumbnailUrl, transfer, onRetry, onDismiss)
    }
}

@Composable
private fun ImageViewerContent(
    attachment: MessageAttachment,
    thumbnailUrl: String?,
    transfer: TransferState?,
    onRetry: () -> Unit,
    onDismiss: () -> Unit
) {
    val reduce = LocalReduceMotion.current
    val scope = rememberCoroutineScope()
    val dismiss by rememberUpdatedState(onDismiss)
    val threshold = with(LocalDensity.current) { 120.dp.toPx() }
    var zoom by remember { mutableStateOf(ZoomState()) }
    var dragY by remember { mutableFloatStateOf(0f) }
    var box by remember { mutableStateOf(Size.Zero) }
    val shade = 1f - (abs(dragY) / (box.height.coerceAtLeast(1f) / 2f)).coerceIn(0f, 0.7f)
    val description = stringResource(R.string.viewer_image, attachment.name)

    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = shade))) {
        Box(
            Modifier
                .fillMaxSize()
                .onSizeChanged { box = it.toSize() }
                .testTag("image-viewer")
                .pointerInput(Unit) {
                    detectTapGestures(onDoubleTap = { tap -> zoom = ZoomMath.doubleTap(zoom, tap, box) })
                }
                .pointerInput(Unit) {
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false)
                        var dragging = false
                        do {
                            val event = awaitPointerEvent()
                            val fingers = event.changes.count { it.pressed }
                            val zoomChange = event.calculateZoom()
                            val pan = event.calculatePan()
                            if (zoom.scale > ZoomMath.MIN_SCALE || fingers > 1) {
                                if (zoomChange != 1f || pan != Offset.Zero) {
                                    zoom = ZoomMath.transform(zoom, zoomChange, pan, event.calculateCentroid(useCurrent = true), box)
                                    event.changes.forEach { if (it.positionChanged()) it.consume() }
                                }
                            } else if (pan != Offset.Zero && (dragging || abs(pan.y) > abs(pan.x))) {
                                // At 1× a vertical drag pulls the picture away to close it.
                                dragging = true
                                dragY += pan.y
                                event.changes.forEach { if (it.positionChanged()) it.consume() }
                            }
                        } while (event.changes.any { it.pressed })
                        if (dragging) {
                            if (ZoomMath.dismisses(dragY, threshold)) {
                                dismiss()
                            } else {
                                val from = dragY
                                if (reduce) dragY = 0f else scope.launch { animate(from, 0f) { value, _ -> dragY = value } }
                            }
                        }
                    }
                },
            contentAlignment = Alignment.Center
        ) {
            Box(
                Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        scaleX = zoom.scale
                        scaleY = zoom.scale
                        translationX = zoom.offset.x
                        translationY = zoom.offset.y + dragY
                    }
                    .testTag(if (zoom.scale > ZoomMath.MIN_SCALE) "image-viewer-zoomed" else "image-viewer-image")
            ) {
                if (thumbnailUrl != null) {
                    AsyncImage(model = thumbnailUrl, contentDescription = description, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                }
                if (transfer is TransferState.Ready) {
                    AsyncImage(model = transfer.file, contentDescription = description, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                }
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .background(Color.Black.copy(alpha = 0.45f))
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onDismiss, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Rounded.Close, contentDescription = stringResource(R.string.action_close), tint = Color.White)
            }
            Text(
                attachment.name,
                style = MaterialTheme.typography.titleMedium,
                color = Color.White,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }

        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .padding(24.dp)
                .semantics { liveRegion = LiveRegionMode.Polite },
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            when (transfer) {
                is TransferState.Running -> {
                    val progress = transfer.progress
                    if (progress != null) {
                        CircularProgressIndicator(progress = { progress }, color = Color.White, trackColor = Color.White.copy(alpha = 0.25f), modifier = Modifier.size(32.dp))
                    } else {
                        CircularProgressIndicator(color = Color.White, modifier = Modifier.size(32.dp))
                    }
                }
                is TransferState.Failed -> {
                    Text(transfer.message, style = MaterialTheme.typography.bodyMedium, color = Color.White)
                    TextButton(onClick = onRetry) { Text(stringResource(R.string.action_retry), color = Color.White) }
                }
                else -> Unit
            }
        }
    }
}
