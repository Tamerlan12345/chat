package com.openmychat.mobile.features.call

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The call level meter: RMS of the peer's PCM frames, shown as five bars. */
class AudioLevelTest {

    @Test
    fun silenceIsZeroAndFullScaleIsOne() {
        assertEquals(0f, AudioLevel.rms(ShortArray(160)), 0.0001f)
        assertEquals(1f, AudioLevel.rms(ShortArray(160) { Short.MAX_VALUE }), 0.001f)
        assertEquals(0f, AudioLevel.rms(ShortArray(0)), 0f)
    }

    @Test
    fun speechLevelsLightTheBarsProgressively() {
        assertEquals(0, AudioLevel.litBars(0f))
        assertEquals(5, AudioLevel.litBars(1f))
        val quiet = AudioLevel.litBars(AudioLevel.rms(ShortArray(160) { if (it % 2 == 0) 600 else -600 }))
        val loud = AudioLevel.litBars(AudioLevel.rms(ShortArray(160) { if (it % 2 == 0) 12_000 else -12_000 }))
        assertTrue("quiet $quiet < loud $loud", quiet in 1..2 && loud in 4..5)
    }

    @Test
    fun theMeterFallsSlowerThanItRises() {
        assertEquals(0.8f, AudioLevel.smooth(previous = 0.2f, next = 0.8f), 0.0001f)
        val fallen = AudioLevel.smooth(previous = 0.8f, next = 0f)
        assertTrue("decays, not drops: $fallen", fallen in 0.5f..0.75f)
    }
}
