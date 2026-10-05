package com.openmychat.mobile.data.delivery

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.testing.DeliveryHarness
import com.openmychat.mobile.testing.FakeDeliveryBackend
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.InMemoryDeliveryStore
import com.openmychat.mobile.testing.MainDispatcherRule
import androidx.work.ListenableWorker
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * The effects executor around the reducer: the persist barrier, alarms on the virtual clock, sync
 * chains and 410, restart from the store, the background HTTP flush and the socket never sending
 * the same entry twice.
 */
class DeliveryEngineTest {

    @get:Rule val main = MainDispatcherRule()

    private val alice = 7L
    private val conv = "direct:$alice"
    private val realtime = FakeRealtimeRepository()

    private fun harness(store: InMemoryDeliveryStore = InMemoryDeliveryStore()) = DeliveryHarness(realtime, null, main.dispatcher, store = store)

    private fun elapse(ms: Long) {
        main.dispatcher.scheduler.advanceTimeBy(ms)
        main.dispatcher.scheduler.runCurrent()
    }

    private fun record(id: Long, key: String, text: String = "привет", from: Long = 1, to: Long = alice) = buildJsonObject {
        put("id", id)
        put("conversation_type", "direct")
        put("target_id", to)
        put("sender_id", from)
        put("text", text)
        put("type", "text")
        put("created_at", "2026-10-05T09:00:00.000Z")
        put("is_deleted", 0)
        put("client_msg_id", key)
    }

    private fun echo(id: Long, key: String) = buildJsonObject {
        put("type", "direct_message")
        put("message", record(id, key))
    }

    private val sendFrames get() = realtime.frames.filter { (it["type"] as JsonPrimitive).content == "send_message" }

    @Test
    fun theOutboxIsOnDiskBeforeAnythingIsSentAndOnlyThenMayTheComposerClear() = runBlocking {
        val order = mutableListOf<String>()
        val store = object : DeliveryStore by InMemoryDeliveryStore() {
            override suspend fun persist(slices: List<String>, state: DeliveryState, cache: Map<String, List<Msg>>) {
                order += "persist $slices"
            }
        }
        val engine = DeliveryEngine(CoroutineScope(main.dispatcher), store, RealtimeDeliveryLink(realtime, com.openmychat.mobile.testing.FakeSessionRepository()), FakeDeliveryBackend(), clock = { 0L })
        realtime.connectionState.value = ConnectionState.Connecting
        engine.start()
        realtime.connectionState.value = ConnectionState.Connected
        order.clear()
        realtime.sent.clear()

        val outcome = engine.enqueue(conv, "привет", clientMsgId = "k1")

        assertTrue(outcome.composerCleared)
        assertEquals("persist [outbox]", order.first())
        assertEquals(listOf("send_message direct 7 привет"), realtime.sent)
    }

    @Test
    fun aFailedWriteKeepsTheTextInTheComposerAndSendsNothing() = runBlocking {
        val store = InMemoryDeliveryStore()
        val h = harness(store)
        store.failNextPersist = java.io.IOException("disk full")

        val outcome = h.engine.enqueue(conv, "не сохранится", clientMsgId = "k1")

        assertFalse(outcome.persisted)
        assertFalse(outcome.composerCleared)
        assertTrue(h.engine.state.value.outbox.isEmpty())
        assertTrue(sendFrames.isEmpty())
    }

    @Test
    fun anUnansweredFrameGoesAgainWithTheSameKeyAfterTheBackoff() = runBlocking {
        val h = harness()
        h.engine.enqueue(conv, "тишина", clientMsgId = "k1")
        assertEquals(1, sendFrames.size)

        elapse(10_000) // ack timeout: failure 1, next attempt in 1 s
        assertEquals(1, sendFrames.size)
        elapse(1_000)

        assertEquals(listOf("k1", "k1"), realtime.sentClientMsgIds)
        assertEquals(1L, h.engine.state.value.outbox.single().failures)
    }

    @Test
    fun aMessageWrittenOfflineIsSentExactlyOnceAfterTheProcessRestarts() = runBlocking {
        val store = InMemoryDeliveryStore()
        realtime.connectionState.value = ConnectionState.Connecting
        val first = harness(store)
        first.engine.enqueue(conv, "из самолёта", clientMsgId = "k1")
        assertTrue(sendFrames.isEmpty())
        first.stop() // the process is killed

        val second = harness(store) // a new process over the same disk
        second.engine.awaitReady()
        assertEquals("restored from the store", listOf("k1"), second.engine.state.value.outbox.map { it.clientMsgId })
        realtime.connectionState.value = ConnectionState.Connected

        assertEquals(listOf("k1"), realtime.sentClientMsgIds)
        realtime.emitFrame(echo(50, "k1"))
        assertTrue(second.engine.state.value.outbox.isEmpty())
        assertTrue("the confirmation reached the disk", store.stored.outbox.isEmpty())

        // Later reconnects resend nothing.
        realtime.connectionState.value = ConnectionState.Connecting
        realtime.connectionState.value = ConnectionState.Connected
        assertEquals(listOf("k1"), realtime.sentClientMsgIds)
    }

    @Test
    fun aMessageStoredBeforeTheDropIsConfirmedBySyncAndNotSentAgain() = runBlocking {
        val h = harness()
        h.engine.enqueue(conv, "ушло", clientMsgId = "k1")
        realtime.connectionState.value = ConnectionState.Connecting
        h.backend.syncAnswers += SyncOutcome.Page(FakeDeliveryBackend.page(listOf(record(60, "k1", "ушло")), "c9"))

        realtime.connectionState.value = ConnectionState.Connected

        assertEquals("only the first attempt", listOf("k1"), realtime.sentClientMsgIds)
        assertTrue(h.engine.state.value.outbox.isEmpty())
        assertEquals(listOf(60L), h.engine.state.value.messages[conv]!!.map { it.id })
    }

    @Test
    fun syncFollowsPagesAndKeepsTheLastCursor() = runBlocking {
        val store = InMemoryDeliveryStore()
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        h.backend.syncAnswers += SyncOutcome.Page(FakeDeliveryBackend.page(listOf(record(1, "a", from = alice, to = 1)), "p1", hasMore = true))
        h.backend.syncAnswers += SyncOutcome.Page(FakeDeliveryBackend.page(listOf(record(2, "b", from = alice, to = 1)), "p2"))

        realtime.connectionState.value = ConnectionState.Connected

        assertEquals(listOf(null, "p1"), h.backend.syncRequests)
        assertEquals("p2", store.stored.cursor)
        assertEquals(listOf(1L, 2L), h.engine.state.value.messages[conv]!!.map { it.id })
        assertEquals("the page's messages reach the cache with the cursor", 2, store.stored.cache[conv]!!.size)
    }

    @Test
    fun aStaleCursorStartsOverWithoutOneAndKeepsTheOutbox() = runBlocking {
        val store = InMemoryDeliveryStore()
        val h = harness(store)
        realtime.connectionState.value = ConnectionState.Connecting
        h.engine.enqueue(conv, "переживёт 410", clientMsgId = "k1")
        val cursor = store.stored.cursor
        h.backend.syncAnswers += SyncOutcome.CursorInvalid(buildJsonObject { put("code", "SYNC_CURSOR_INVALID") })

        realtime.connectionState.value = ConnectionState.Connected

        assertEquals(listOf(cursor, null), h.backend.syncRequests.takeLast(2))
        assertEquals("sent after the full resync", listOf("k1"), realtime.sentClientMsgIds)
    }

    @Test
    fun theBackgroundFlushAndTheSocketNeverSendTheSameEntryTwice() = runBlocking {
        val store = InMemoryDeliveryStore()
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        h.engine.enqueue(conv, "одна доставка", clientMsgId = "k1")
        val gate = CompletableDeferred<Unit>()
        h.backend.postGate = gate
        h.backend.postAnswer = { _, body -> com.openmychat.mobile.data.delivery.HttpOutcome(201, record(70, (body["client_msg_id"] as JsonPrimitive).content, "одна доставка")) }

        // The worker posts while there is no socket…
        val flush = CoroutineScope(main.dispatcher).async { h.runtime.flushInBackground() }
        assertEquals(1, h.backend.posts.size)
        assertEquals("/api/messages/direct/7", h.backend.posts.single().first)
        // …and the socket comes back while the request is in flight: its pump leaves the entry alone.
        realtime.connectionState.value = ConnectionState.Connected
        assertTrue("no frame for an entry the HTTP request carries", sendFrames.isEmpty())

        gate.complete(Unit)
        assertEquals(ListenableWorker.Result.success(), flush.await())

        assertTrue(h.engine.state.value.outbox.isEmpty())
        assertEquals(1, h.backend.posts.size)
        assertTrue(sendFrames.isEmpty())
        assertEquals(listOf(70L), h.engine.state.value.messages[conv]!!.map { it.id })
    }

    @Test
    fun withTheSocketUpTheBackgroundFlushSendsNothing() = runBlocking {
        val h = harness()
        h.engine.enqueue(conv, "по сокету", clientMsgId = "k1")

        val result = h.runtime.flushInBackground()

        assertEquals(ListenableWorker.Result.success(), result)
        assertTrue(h.backend.posts.isEmpty())
        assertEquals(listOf("k1"), realtime.sentClientMsgIds)
    }

    @Test
    fun aQueuedMessageAsksForABackgroundFlushOnlyWhileThereIsNoSocket() = runBlocking {
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness()
        assertEquals(0, h.flushesScheduled)

        h.engine.enqueue(conv, "ждёт сети", clientMsgId = "k1")

        assertEquals(1, h.flushesScheduled)
    }

    @Test
    fun aWriteThatCannotBeStoredForAServerFrameRestartsTheSocket() = runBlocking {
        val store = InMemoryDeliveryStore()
        val h = harness(store)
        h.engine.enqueue(conv, "x", clientMsgId = "k1")
        store.failNextPersist = java.io.IOException("disk")

        realtime.emitFrame(echo(80, "k1"))

        assertEquals("the next socket's sync returns the same data", 1, realtime.restarts)
        assertEquals("the echo was not applied", listOf("k1"), h.engine.state.value.outbox.map { it.clientMsgId })
    }

    @Test
    fun signingOutWipesTheModelAndItsStorage() = runBlocking {
        val store = InMemoryDeliveryStore()
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        h.engine.enqueue(conv, "чужому не достанется", clientMsgId = "k1")

        h.session.token.value = null

        assertTrue(h.engine.state.value.outbox.isEmpty())
        assertTrue(store.stored.outbox.isEmpty())
        assertNull(store.stored.cursor)
    }

    @Test
    fun theConversationCacheFillsTheModelAgainAfterARestart() = runBlocking {
        val store = InMemoryDeliveryStore()
        val h = harness(store)
        h.engine.historyPage(listOf(record(5, "x", "старое", from = alice, to = 1)))
        elapse(2_000) // the batched cache write
        h.stop()

        val restarted = harness(store)
        restarted.engine.awaitReady()

        assertEquals(listOf(5L), restarted.engine.state.value.messages[conv]!!.map { it.id })
        assertEquals("старое", restarted.engine.state.value.messages[conv]!!.single().text)
    }

    @Test
    fun aDeletionHidesTheMessageAtOnceAndIsRetriedUntilTheTombstone() = runBlocking {
        val h = harness()
        h.engine.historyPage(listOf(record(9, "k9", "моё")))
        realtime.sent.clear()

        h.engine.delete(9)
        assertEquals(listOf("delete_message 9"), realtime.sent)
        elapse(10_000)
        elapse(1_000)
        assertEquals("no tombstone yet: sent again", listOf("delete_message 9", "delete_message 9"), realtime.sent)

        realtime.emitFrame(buildJsonObject {
            put("type", "message_deleted")
            put("messageId", 9)
        })
        assertTrue(h.engine.state.value.ops.isEmpty())
        assertEquals(1, h.engine.state.value.messages[conv]!!.single().isDeleted)
    }

    @Suppress("unused")
    private fun JsonObject.str(key: String) = (this[key] as? JsonPrimitive)?.content
}
