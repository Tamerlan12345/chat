package com.openmychat.mobile.features.call

import kotlin.math.ceil
import kotlin.math.log10
import kotlin.math.sqrt

/** The call level meter's numbers: RMS of a PCM frame, lit bars on a speech-shaped (dB) scale. */
object AudioLevel {
    /** Quietest level that lights a bar, in dBFS. */
    private const val FLOOR_DB = -50.0

    /** Root mean square of 16-bit PCM, 0 (silence) .. 1 (full scale). */
    fun rms(samples: ShortArray): Float {
        if (samples.isEmpty()) return 0f
        var sum = 0.0
        for (s in samples) sum += s.toDouble() * s
        return (sqrt(sum / samples.size) / Short.MAX_VALUE).toFloat().coerceIn(0f, 1f)
    }

    /** How many of [bars] are lit for [level]: decibels from -50 dBFS (none) to 0 dBFS (all). */
    fun litBars(level: Float, bars: Int = 5): Int {
        if (level <= 0f) return 0
        val db = 20.0 * log10(level.toDouble())
        val normalized = ((db - FLOOR_DB) / -FLOOR_DB).coerceIn(0.0, 1.0)
        return ceil(normalized * bars).toInt().coerceIn(0, bars)
    }

    /** The meter jumps up with the voice and falls back gently (15% per frame). */
    fun smooth(previous: Float, next: Float): Float = if (next >= previous) next else maxOf(next, previous * 0.85f)
}
