package com.openmychat.mobile.data.delivery

import androidx.work.ListenableWorker
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.features.chat.AttachmentSends
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Asks the OS to run a background flush once there is a network (WorkManager in the app). */
fun interface BackgroundFlushScheduler {
    fun schedule()
}

/**
 * Starts the delivery engine and the file queue with the process, wipes both when the session
 * ends (a session's messages never outlive it), and asks for a background flush whenever something
 * waits to be sent while there is no socket.
 */
class DeliveryRuntime(
    private val engine: DeliveryEngine,
    private val sends: AttachmentSends,
    private val session: SessionRepository,
    private val realtime: RealtimeRepository,
    private val scope: CoroutineScope,
    private val scheduler: BackgroundFlushScheduler
) {
    private var started = false

    @Synchronized
    fun start() {
        if (started) return
        started = true
        engine.start()
        sends.start(realtime.connectionState.map { it == ConnectionState.Connected }.distinctUntilChanged())
        scope.launch {
            session.token.collect { token ->
                if (token == null) {
                    engine.reset()
                    sends.reset()
                }
            }
        }
        scope.launch {
            combine(engine.state, engine.ready, sends.uploads) { state, ready, uploads ->
                ready && state.connection != DeliveryState.ONLINE && (hasSendable(state) || uploads.any { !it.pending.failed })
            }.distinctUntilChanged().collect { waiting -> if (waiting) scheduler.schedule() }
        }
    }

    /**
     * One run of the background flush (no socket): files go up and enter the outbox, then the heads
     * of the outbox go over HTTP (`background_flush`, §6.2), round after round while it moves.
     */
    suspend fun flushInBackground(): ListenableWorker.Result {
        start()
        engine.awaitReady()
        if (session.token.value == null) return ListenableWorker.Result.success()
        sends.flush()
        for (round in 0 until MAX_ROUNDS) {
            val state = engine.state.value
            // The socket is up: its pump sends, and two senders never share an entry.
            if (state.connection == DeliveryState.ONLINE || !hasSendable(state)) return ListenableWorker.Result.success()
            val outcome = engine.backgroundFlush()
            if (outcome.effects.none { it is DeliveryEffect.SendHttp }) break
            // Wait for this round's answers (or their HTTP ack timeouts) before the next heads go.
            withTimeoutOrNull(DeliveryReducer.HTTP_ACK_TIMEOUT_MS + ROUND_SLACK_MS) {
                engine.state.first { s -> s.outbox.none { it.state == OutboxEntry.SENDING && it.transport == OutboxEntry.HTTP } }
            }
        }
        val left = engine.state.value
        return if (left.connection != DeliveryState.ONLINE && hasSendable(left)) ListenableWorker.Result.retry() else ListenableWorker.Result.success()
    }

    companion object {
        private const val MAX_ROUNDS = 20
        private const val ROUND_SLACK_MS = 5_000L

        /** Entries that still go out on their own (not refused, not cancelled). */
        fun hasSendable(state: DeliveryState): Boolean =
            state.outbox.any { it.state != OutboxEntry.FAILED && !it.pendingDelete }
    }
}
