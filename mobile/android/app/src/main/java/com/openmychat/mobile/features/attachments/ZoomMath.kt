package com.openmychat.mobile.features.attachments

import androidx.compose.runtime.Immutable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size

/** Zoom of the image viewer: [offset] is the translation from the centre, in pixels. */
@Immutable
data class ZoomState(val scale: Float = 1f, val offset: Offset = Offset.Zero)

/** Pinch, pan and double tap within the viewer's box; a swipe down past a threshold closes it. */
object ZoomMath {
    const val MIN_SCALE = 1f
    const val MAX_SCALE = 5f
    const val DOUBLE_TAP_SCALE = 2.5f

    /** One gesture step: [zoom] around [centroid] (box coordinates), then [pan]. */
    fun transform(state: ZoomState, zoom: Float, pan: Offset, centroid: Offset, box: Size): ZoomState {
        val scale = (state.scale * zoom).coerceIn(MIN_SCALE, MAX_SCALE)
        val factor = scale / state.scale
        // Keep the point under the fingers where it is: offset' = offset·f + c·(1 − f), c from the centre.
        val fromCentre = centroid - Offset(box.width / 2f, box.height / 2f)
        val offset = state.offset * factor + fromCentre * (1f - factor) + pan
        return ZoomState(scale, clamp(offset, scale, box))
    }

    /** In around the tap when at 1×, back to 1× otherwise. */
    fun doubleTap(state: ZoomState, tap: Offset, box: Size): ZoomState =
        if (state.scale > MIN_SCALE) ZoomState() else transform(state, DOUBLE_TAP_SCALE, Offset.Zero, tap, box)

    fun dismisses(dragY: Float, threshold: Float): Boolean = dragY > threshold

    private fun clamp(offset: Offset, scale: Float, box: Size): Offset {
        val maxX = box.width * (scale - 1f) / 2f
        val maxY = box.height * (scale - 1f) / 2f
        return Offset(offset.x.coerceIn(-maxX, maxX), offset.y.coerceIn(-maxY, maxY))
    }
}
