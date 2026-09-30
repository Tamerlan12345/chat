package com.openmychat.mobile.core.audio

import kotlin.math.abs

object SilenceGater {
    /**
     * Threshold as defined in CentyChat audio parity matrix & WS protocol.
     * Normalized Float32 amplitude [-1.0 .. 1.0].
     */
    const val SILENCE_THRESHOLD = 0.0015f
    const val FRAME_SAMPLES = 512

    /**
     * Determines whether a frame of 16-bit PCM samples is silent.
     * avg = sum(abs(sample / 32768.0)) / count
     */
    fun isSilence(samples: ShortArray): Boolean {
        if (samples.isEmpty()) return true
        var sum = 0.0
        for (sample in samples) {
            sum += abs(sample.toInt()) / 32768.0
        }
        val avg = sum / samples.size
        return avg < SILENCE_THRESHOLD
    }

    /**
     * Computes the normalized average amplitude [0.0 .. 1.0] of a PCM frame.
     */
    fun calculateAverageAmplitude(samples: ShortArray): Float {
        if (samples.isEmpty()) return 0f
        var sum = 0.0
        for (sample in samples) {
            sum += abs(sample.toInt()) / 32768.0
        }
        return (sum / samples.size).toFloat()
    }
}
