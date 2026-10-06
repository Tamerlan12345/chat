package com.openmychat.mobile.features.chat

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The `typing` frame (ws-protocol.md §3.6) without a frame per keystroke: one when typing starts,
 * then at most one per [INTERVAL_MS] while it goes on (the desktop's cadence), and a single stop
 * frame when the field has been still for [IDLE_MS], is cleared, or the message is sent ([stop]).
 */
internal class TypingSignal(private val scope: CoroutineScope, private val send: (Boolean) -> Unit) {
    private var typing = false
    private var cooldown: Job? = null
    private var idle: Job? = null

    /** The field changed: [active] is false once it is empty. */
    fun onInput(active: Boolean) {
        if (!active) return stop()
        idle?.cancel()
        idle = scope.launch {
            delay(IDLE_MS)
            stop()
        }
        if (!typing || cooldown?.isActive != true) {
            typing = true
            send(true)
            cooldown = scope.launch { delay(INTERVAL_MS) }
        }
    }

    /** Sent, cleared or left: one stop frame, only after a typing frame. */
    fun stop() {
        idle?.cancel()
        idle = null
        cooldown?.cancel()
        cooldown = null
        if (typing) {
            typing = false
            send(false)
        }
    }

    companion object {
        const val INTERVAL_MS = 3_000L
        const val IDLE_MS = 5_000L

        /** How long a peer's «печатает» stays without a new frame: two intervals, like the desktop. */
        const val PEER_HOLD_MS = 6_000L
    }
}
