package com.openmychat.mobile.core.audio

import java.util.concurrent.ConcurrentLinkedQueue

/**
 * JitterScheduler for CentyChat audio relay.
 * Implements the 60ms target lead and 250ms ceiling as specified in contracts.
 */
class JitterBuffer(
    val sampleRate: Int = 16000,
    val frameSamples: Int = 512
) {
    // 512 samples at 16kHz = 32ms per frame
    val frameDurationMs: Long = (frameSamples * 1000L) / sampleRate

    val targetLeadMs: Long = 60L
    val maxLeadMs: Long = 250L

    private val queue = ConcurrentLinkedQueue<ShortArray>()

    @Volatile
    private var isPrimed = false

    fun enqueue(pcmSamples: ShortArray) {
        queue.offer(pcmSamples)

        val bufferedDurationMs = queue.size * frameDurationMs
        if (bufferedDurationMs > maxLeadMs) {
            // Drop oldest frames until buffered duration is back to ~targetLeadMs (60ms = ~2 frames)
            val desiredSize = (targetLeadMs / frameDurationMs).coerceAtLeast(1).toInt()
            while (queue.size > desiredSize) {
                queue.poll()
            }
        }

        if (!isPrimed && bufferedDurationMs >= targetLeadMs) {
            isPrimed = true
        }
    }

    fun poll(): ShortArray? {
        if (!isPrimed) {
            // Buffer hasn't reached target lead yet
            if (queue.size * frameDurationMs >= targetLeadMs) {
                isPrimed = true
            } else {
                return null
            }
        }
        return queue.poll()
    }

    fun clear() {
        queue.clear()
        isPrimed = false
    }

    val currentBufferedMs: Long
        get() = queue.size * frameDurationMs
}
