package com.openmychat.mobile.data.delivery

import androidx.work.ListenableWorker
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.features.chat.AttachmentSends
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** What sign-out needs to know about messages that have not left the device. */
interface OutgoingQueue {
    /** Messages and files of this account not on the server yet (cancelled ones excluded). */
    val unsentCount: StateFlow<Int>

    /** Explicit sign-out: they are deleted. Throws when that could not be done (nothing is signed out then). */
    suspend fun discardForSignOut()

    object None : OutgoingQueue {
        override val unsentCount: StateFlow<Int> = MutableStateFlow(0)
        override suspend fun discardForSignOut() = Unit
    }
}

/** Asks the OS to run a background flush once there is a network (WorkManager in the app). */
fun interface BackgroundFlushScheduler {
    fun schedule()
}

/**
 * Starts the delivery engine and the file queue with the process and asks for a background flush
 * whenever something waits to be sent while there is no socket.
 *
 * The queue belongs to an account. A session that ends by itself (a 401, a refused token) keeps it —
 * it goes out once the same account is back. It is deleted only by an explicit sign-out (after the
 * user agreed, [discardForSignOut]) or when another account signs in ([DeliveryEngine.adopt]).
 */
class DeliveryRuntime(
    private val engine: DeliveryEngine,
    private val sends: AttachmentSends,
    private val session: SessionRepository,
    private val realtime: RealtimeRepository,
    private val scope: CoroutineScope,
    private val scheduler: BackgroundFlushScheduler,
    /** Failures nobody waits for (Logcat in the app). */
    private val log: (String, Throwable?) -> Unit = { _, _ -> }
) : OutgoingQueue {
    override val unsentCount: StateFlow<Int> = combine(engine.state, sends.uploads) { state, uploads ->
        state.outbox.count { !it.pendingDelete } + uploads.size
    }.stateIn(scope, SharingStarted.Eagerly, 0)

    /** Throws when the store could not be emptied: the caller must not sign out as if it had been. */
    override suspend fun discardForSignOut() {
        engine.reset()
        sends.reset()
    }

    private var started = false

    @Synchronized
    fun start() {
        if (started) return
        started = true
        engine.start(signedInAs = session.currentUserId)
        sends.start(realtime.connectionState.map { it == ConnectionState.Connected }.distinctUntilChanged())
        scope.launch {
            // Another account signing in never inherits this queue (nor sends it).
            session.currentUser.map { it?.id }.distinctUntilChanged().collect { id ->
                if (id != null) adopt(id)
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
        // A store that cannot be read is retried by the engine; this run tries again later.
        withTimeoutOrNull(READY_TIMEOUT_MS) { engine.awaitReady() } ?: return ListenableWorker.Result.retry()
        if (session.token.value == null) return ListenableWorker.Result.success()
        // Only this account's queue goes out under this account's token.
        val user = session.currentUserId ?: return ListenableWorker.Result.success()
        if (!adopt(user)) return ListenableWorker.Result.retry()
        sends.flush()
        for (round in 0 until MAX_ROUNDS) {
            val state = engine.state.value
            // The socket is up: its pump sends, and two senders never share an entry.
            if (state.connection == DeliveryState.ONLINE) return ListenableWorker.Result.success()
            if (!hasSendable(state)) break
            val outcome = engine.backgroundFlush()
            if (outcome.effects.none { it is DeliveryEffect.SendHttp }) break
            // Wait for this round's answers (or their HTTP ack timeouts) before the next heads go.
            withTimeoutOrNull(DeliveryReducer.HTTP_ACK_TIMEOUT_MS + ROUND_SLACK_MS) {
                engine.state.first { s -> s.outbox.none { it.state == OutboxEntry.SENDING && it.transport == OutboxEntry.HTTP } }
            }
        }
        val left = engine.state.value
        val waiting = hasSendable(left) || sends.uploads.value.any { !it.pending.failed }
        return if (left.connection != DeliveryState.ONLINE && waiting) ListenableWorker.Result.retry() else ListenableWorker.Result.success()
    }

    /** The queue is [user]'s (another account's is wiped). False when that failed — logged, never silent. */
    private suspend fun adopt(user: Long): Boolean = try {
        engine.adopt(user)
        true
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        log("delivery queue could not be handed to account $user", e)
        false
    }

    companion object {
        private const val MAX_ROUNDS = 20
        private const val ROUND_SLACK_MS = 5_000L
        private const val READY_TIMEOUT_MS = 60_000L

        /** Entries that still go out on their own (not refused, not cancelled). */
        fun hasSendable(state: DeliveryState): Boolean =
            state.outbox.any { it.state != OutboxEntry.FAILED && !it.pendingDelete }
    }
}
