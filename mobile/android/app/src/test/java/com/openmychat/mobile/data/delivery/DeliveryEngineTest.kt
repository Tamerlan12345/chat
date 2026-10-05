package com.openmychat.mobile.data.delivery

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.testing.DeliveryHarness
import com.openmychat.mobile.testing.FakeDeliveryBackend
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.InMemoryDeliveryStore
import com.openmychat.mobile.data.delivery.StoredDelivery
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
    fun anExplicitSignOutCountsTheUnsentFirstThenWipesTheModelAndItsStorage() = runBlocking {
        val store = InMemoryDeliveryStore()
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        h.engine.enqueue(conv, "первое", clientMsgId = "k1")
        h.engine.enqueue(conv, "второе", clientMsgId = "k2")
        assertEquals("what the confirmation names", 2, h.runtime.unsentCount.value)

        h.runtime.discardForSignOut()

        assertTrue(h.engine.state.value.outbox.isEmpty())
        assertTrue(store.stored.outbox.isEmpty())
        assertNull(store.stored.cursor)
        assertEquals(0, h.runtime.unsentCount.value)
    }

    @Test
    fun anInvoluntarySessionEndKeepsTheOutboxForTheSameAccount() = runBlocking {
        // Review fix 1b: a 401 or a refused token is not a sign-out; nothing unsent is dropped (T19).
        val store = InMemoryDeliveryStore()
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        h.engine.enqueue(conv, "переживёт 401", clientMsgId = "k1")

        h.session.token.value = null
        assertEquals(listOf("k1"), h.engine.state.value.outbox.map { it.clientMsgId })
        assertEquals(listOf("k1"), store.stored.outbox.map { it.clientMsgId })

        h.session.token.value = "renewed" // the same account signs in again
        realtime.connectionState.value = ConnectionState.Connected
        assertEquals(listOf("k1"), realtime.sentClientMsgIds)
    }

    @Test
    fun anotherAccountSigningInNeverSendsThePreviousAccountsText() = runBlocking {
        val store = InMemoryDeliveryStore()
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        h.engine.enqueue(conv, "текст Алисы", clientMsgId = "k1")
        h.session.token.value = null

        h.session.currentUser.value = com.openmychat.mobile.data.model.User(id = 99, username = "carol", fullName = "Кэрол")
        h.session.token.value = "carol"
        realtime.me = 99
        realtime.connectionState.value = ConnectionState.Connected

        assertTrue("nothing of the previous account goes out", sendFrames.isEmpty())
        assertTrue(h.engine.state.value.outbox.isEmpty())
        assertTrue("and nothing of it stays on disk", store.stored.outbox.isEmpty())
    }

    @Test
    fun anotherAccountsBackgroundFlushPostsNothingOfThePreviousAccount() = runBlocking {
        val store = InMemoryDeliveryStore()
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        h.engine.enqueue(conv, "текст Алисы", clientMsgId = "k1")
        h.session.currentUser.value = com.openmychat.mobile.data.model.User(id = 99, username = "carol", fullName = "Кэрол")

        h.runtime.flushInBackground()

        assertTrue(h.backend.posts.isEmpty())
        assertTrue(store.stored.outbox.isEmpty())
    }

    @Test
    fun aWipeThatFailsIsReportedAndStillNeverSendsTheOldOutbox() = runBlocking {
        val store = object : InMemoryDeliveryStore() {
            override suspend fun clear() = throw java.io.IOException("disk")
        }
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        h.engine.enqueue(conv, "текст Алисы", clientMsgId = "k1")

        try {
            h.runtime.discardForSignOut()
            org.junit.Assert.fail("a sign-out that could not delete must say so")
        } catch (e: java.io.IOException) {
            // reaches the caller instead of leaving it waiting
        }

        h.session.currentUser.value = com.openmychat.mobile.data.model.User(id = 99, username = "carol", fullName = "Кэрол")
        realtime.me = 99
        realtime.connectionState.value = ConnectionState.Connected
        assertTrue(sendFrames.isEmpty())
    }

    @Test
    fun aStoreThatCannotBeReadIsNotOverwrittenAndNothingIsAcceptedUntilItIs() = runBlocking {
        // Review fix 2: a failed load must not let the next persist replace the durable outbox.
        var failures = 2
        val store = object : InMemoryDeliveryStore() {
            override suspend fun load(): StoredDelivery {
                if (failures-- > 0) throw java.io.IOException("locked")
                return super.load()
            }
        }
        store.persist(listOf("outbox"), DeliveryState(me = 1, seq = 1).apply {
            outbox.add(OutboxEntry(clientMsgId = "k0", conversation = conv, seq = 1, text = "с прошлого запуска"))
        }, emptyMap())
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        assertFalse(h.engine.ready.value)

        val outcome = h.engine.enqueue(conv, "пока не прочитано", clientMsgId = "k1")

        assertFalse("refused, the composer keeps the text", outcome.persisted)
        assertEquals("the stored outbox is intact", listOf("k0"), store.stored.outbox.map { it.clientMsgId })

        elapse(10_000) // the load is tried again
        assertTrue(h.engine.ready.value)
        assertEquals(listOf("k0"), h.engine.state.value.outbox.map { it.clientMsgId })
        realtime.connectionState.value = ConnectionState.Connected
        assertEquals(listOf("k0"), realtime.sentClientMsgIds)
    }

    @Test
    fun theWorkerDoesNotWaitForeverOnAStoreThatCannotBeRead() = runBlocking {
        val store = object : InMemoryDeliveryStore() {
            override suspend fun load(): StoredDelivery = throw java.io.IOException("locked")
        }
        val h = harness(store)

        val result = CoroutineScope(main.dispatcher).async { h.runtime.flushInBackground() }
        elapse(120_000)

        assertTrue(result.isCompleted)
        assertEquals(ListenableWorker.Result.retry(), result.await())
    }

    @Test
    fun theWorkerAsksAgainWhileAFileStillWaits() = runBlocking {
        val files = com.openmychat.mobile.testing.FakeAttachmentRepository()
        val pdf = com.openmychat.mobile.data.repository.PickedFile("content://docs/1", "отчёт.pdf", 2048, "application/pdf")
        files.uploadFailure = com.openmychat.mobile.core.network.ApiException(0, "NETWORK_ERROR", "timeout")
        realtime.connectionState.value = ConnectionState.Connecting
        val h = DeliveryHarness(realtime, null, main.dispatcher, files = files)
        assertTrue(h.sends.add(conv, pdf, null))

        val result = h.runtime.flushInBackground()

        assertEquals("the file is still queued", ListenableWorker.Result.retry(), result)
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
