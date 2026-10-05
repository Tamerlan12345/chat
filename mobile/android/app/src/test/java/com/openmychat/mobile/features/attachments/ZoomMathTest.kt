package com.openmychat.mobile.features.attachments

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pinch, pan and double tap of the image viewer stay within the picture; a swipe down closes it. */
class ZoomMathTest {

    private val box = Size(1000f, 2000f)

    @Test
    fun zoomStaysBetweenOneAndFive() {
        assertEquals(1f, ZoomMath.transform(ZoomState(), zoom = 0.2f, pan = Offset.Zero, centroid = Offset(500f, 1000f), box).scale)
        assertEquals(5f, ZoomMath.transform(ZoomState(scale = 4f), zoom = 3f, pan = Offset.Zero, centroid = Offset(500f, 1000f), box).scale)
    }

    @Test
    fun pinchingKeepsThePointUnderTheFingers() {
        // Zooming 2x around a point 100px right of centre moves the picture 100px left.
        val zoomed = ZoomMath.transform(ZoomState(), zoom = 2f, pan = Offset.Zero, centroid = Offset(600f, 1000f), box)
        assertEquals(2f, zoomed.scale)
        assertEquals(Offset(-100f, 0f), zoomed.offset)
    }

    @Test
    fun panningStopsAtThePicturesEdge() {
        val panned = ZoomMath.transform(ZoomState(scale = 2f), zoom = 1f, pan = Offset(5000f, -5000f), centroid = Offset(500f, 1000f), box)
        assertEquals("half the overflow on each side", Offset(500f, -1000f), panned.offset)
    }

    @Test
    fun atOneTimesThereIsNothingToPan() {
        assertEquals(Offset.Zero, ZoomMath.transform(ZoomState(), zoom = 1f, pan = Offset(300f, 300f), centroid = Offset.Zero, box).offset)
    }

    @Test
    fun aDoubleTapZoomsInAroundTheTapAndASecondOneResets() {
        val zoomed = ZoomMath.doubleTap(ZoomState(), tap = Offset(500f, 1000f), box)
        assertEquals(ZoomMath.DOUBLE_TAP_SCALE, zoomed.scale)
        assertEquals(Offset.Zero, zoomed.offset)
        assertEquals(ZoomState(), ZoomMath.doubleTap(zoomed, tap = Offset(10f, 10f), box))
    }

    @Test
    fun aLongEnoughSwipeDownCloses() {
        assertTrue(ZoomMath.dismisses(dragY = 300f, threshold = 250f))
        assertFalse(ZoomMath.dismisses(dragY = 100f, threshold = 250f))
        assertFalse("up does not close", ZoomMath.dismisses(dragY = -400f, threshold = 250f))
    }
}
