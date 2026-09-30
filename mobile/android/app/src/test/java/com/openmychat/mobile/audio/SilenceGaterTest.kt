package com.openmychat.mobile.audio

import com.openmychat.mobile.core.audio.SilenceGater
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SilenceGaterTest {

    @Test
    fun testAllZerosFrameIsSilence() {
        val frame = ShortArray(512) { 0 }
        assertTrue("All-zero frame must be silence", SilenceGater.isSilence(frame))
    }

    @Test
    fun testSubThresholdNoiseIsSilence() {
        // Threshold: 0.0015 * 32768 = 49.152
        // Frame with average amplitude of 20 (< 49)
        val frame = ShortArray(512) { 20 }
        assertTrue("Sub-threshold noise frame must be treated as silence", SilenceGater.isSilence(frame))
    }

    @Test
    fun testLoudAudioFrameIsNotSilence() {
        // Frame with speech amplitude e.g. 4000
        val frame = ShortArray(512) { 4000 }
        assertFalse("Frame with clear speech amplitude must NOT be silence", SilenceGater.isSilence(frame))
    }

    @Test
    fun testEmptyFrameIsSilence() {
        val frame = ShortArray(0)
        assertTrue("Empty frame is silence", SilenceGater.isSilence(frame))
    }
}
