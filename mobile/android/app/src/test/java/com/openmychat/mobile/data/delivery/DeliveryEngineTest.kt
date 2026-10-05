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
import kotlinx.coroutines.launch
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
    fun aStoreReadLateWhileAnotherAccountIsConnectedIsWipedNotSent() = runBlocking {
        // Review fix B1: the restore must apply the same owner rule as a live auth_success.
        var failures = 2
        val store = object : InMemoryDeliveryStore() {
            override suspend fun load(): StoredDelivery {
                if (failures-- > 0) throw java.io.IOException("locked")
                return super.load()
            }
        }
        store.persist(listOf("cancelled", "cursor", "ops", "outbox"), DeliveryState(me = 1, seq = 1).apply {
            sync.cursor = "a-cursor"
            outbox.add(OutboxEntry(clientMsgId = "k0", conversation = conv, seq = 1, text = "текст Алисы"))
        }, emptyMap())
        realtime.me = 99
        val carol = com.openmychat.mobile.testing.FakeSessionRepository(99)
        val h = DeliveryHarness(realtime, null, main.dispatcher, session = carol, store = store)

        elapse(10_000) // the load succeeds while Кэрол's socket is already up

        assertTrue(h.engine.ready.value)
        assertTrue("nothing of Алиса goes out under Кэрол", sendFrames.isEmpty())
        assertTrue(store.stored.outbox.isEmpty())
        assertTrue("Алиса's cursor is not used for Кэрол", h.backend.syncRequests.none { it == "a-cursor" })
        assertEquals(99L, h.engine.state.value.me)
    }

    @Test
    fun aQueueWrittenRightAfterAFailedWipeStillBelongsToItsAccount() = runBlocking {
        // Review fix B1: B queues offline after A's queue was wiped (late, after a failed delete);
        // B's session ends by itself; C signs in — C must never send B's text.
        var clearFailures = 1
        val store = object : InMemoryDeliveryStore() {
            override suspend fun clear() {
                if (clearFailures-- > 0) throw java.io.IOException("busy")
                super.clear()
            }
        }
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        h.engine.enqueue(conv, "текст Алисы", clientMsgId = "k1")

        h.session.currentUser.value = com.openmychat.mobile.data.model.User(id = 2, username = "bob", fullName = "Боб")
        elapse(5_000) // the wipe of Алиса's queue succeeds on its retry
        assertTrue(store.stored.outbox.isEmpty())
        h.engine.enqueue("direct:5", "текст Боба", clientMsgId = "k2")
        assertEquals("the entry carries its account", 2L, store.stored.me)
        h.session.token.value = null

        h.session.currentUser.value = com.openmychat.mobile.data.model.User(id = 3, username = "carol", fullName = "Кэрол")
        h.session.token.value = "carol"
        realtime.me = 3
        realtime.connectionState.value = ConnectionState.Connected

        assertTrue("nothing of Боб goes out under Кэрол", sendFrames.isEmpty())
        assertTrue(store.stored.outbox.isEmpty())
    }

    @Test
    fun signingOutWhileTheStoreCannotBeReadLeavesAWorkingEmptyQueue() = runBlocking {
        // Review fix B2: the wipe repairs the store, so the engine must become ready again.
        val store = object : InMemoryDeliveryStore() {
            override suspend fun load(): StoredDelivery = throw java.io.IOException("locked")
        }
        val h = harness(store)
        assertFalse(h.engine.ready.value)

        h.runtime.discardForSignOut()

        assertTrue(h.engine.ready.value)
        h.session.currentUser.value = com.openmychat.mobile.data.model.User(id = 2, username = "bob", fullName = "Боб")
        assertTrue(h.engine.enqueue(conv, "после выхода", clientMsgId = "k1").persisted)
    }

    @Test
    fun aFailedAdoptionIsLoggedByTheRuntime() = runBlocking {
        // Review fix B3: nothing is swallowed silently.
        val store = object : InMemoryDeliveryStore() {
            override suspend fun clear() = throw java.io.IOException("disk")
        }
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        h.engine.enqueue(conv, "текст Алисы", clientMsgId = "k1")

        h.session.currentUser.value = com.openmychat.mobile.data.model.User(id = 99, username = "carol", fullName = "Кэрол")

        assertTrue(h.logged.toString(), h.logged.any { it.contains("99") })
        assertTrue("and still nothing of Алиса can go out", h.engine.state.value.outbox.isEmpty())
    }

    @Test
    fun aFileQueuedByOneAccountNeverGoesUpForTheNextAfterARestart() = runBlocking {
        // Review fix round 3: B attaches right after signing in on a fresh install (nothing else was
        // stored yet), the process dies, B's session ends by itself, C signs in.
        val uploads = com.openmychat.mobile.testing.InMemoryUploadStore()
        val store = InMemoryDeliveryStore(uploads)
        val files = com.openmychat.mobile.testing.FakeAttachmentRepository()
        val pdf = com.openmychat.mobile.data.repository.PickedFile("content://docs/1", "отчёт.pdf", 2048, "application/pdf")
        realtime.connectionState.value = ConnectionState.Connecting
        val bob = DeliveryHarness(realtime, null, main.dispatcher, session = com.openmychat.mobile.testing.FakeSessionRepository(2), uploadStore = uploads, store = store, files = files)
        assertTrue(bob.sends.add("direct:7", pdf, null))
        bob.stop() // the process dies before anything else is stored

        realtime.me = 3
        realtime.connectionState.value = ConnectionState.Connected
        val carol = DeliveryHarness(realtime, null, main.dispatcher, session = com.openmychat.mobile.testing.FakeSessionRepository(3), uploadStore = uploads, store = store, files = files)
        carol.engine.awaitReady()

        assertTrue("Боб's file never goes up under Кэрол", files.uploads.isEmpty())
        assertTrue(sendFrames.isEmpty())
        assertTrue(carol.sends.uploads.value.isEmpty())
        assertTrue("and its row is gone", uploads.all().isEmpty())
    }

    @Test
    fun framesOfTheSignedOutAccountNeverReachTheNextOne() = runBlocking {
        // Review fix round 3: sign-out deletes the queue before the server logout; the old socket is
        // still up meanwhile and its frames must not land in the (now ownerless) model or cache.
        val store = InMemoryDeliveryStore()
        val h = harness(store)
        h.runtime.discardForSignOut()

        realtime.emitFrame(buildJsonObject {
            put("type", "new_message")
            put("message", record(300, "x", "для Алисы", from = alice, to = 1))
        })
        elapse(2_000) // a batched cache write would have happened by now
        h.session.currentUser.value = com.openmychat.mobile.data.model.User(id = 2, username = "bob", fullName = "Боб")
        realtime.me = 2
        realtime.connectionState.value = ConnectionState.Connecting
        realtime.connectionState.value = ConnectionState.Connected

        assertTrue("Боб never sees Алиса's message", h.engine.state.value.messages.values.flatten().none { it.id == 300L })
        assertTrue(store.stored.cache.values.flatten().none { it["id"].toString() == "300" })
    }

    @Test
    fun aRestoreNeverShowsAnotherAccountsMessagesEvenForAMoment() = runBlocking {
        // Review fix round 3 (minor): the owner check runs before the stored model is replayed.
        val store = InMemoryDeliveryStore()
        store.persist(listOf("outbox"), DeliveryState(me = 1, seq = 0), mapOf(conv to listOf(DeliveryReducer.project(record(400, "y", "секрет Алисы", from = alice, to = 1), null))))
        realtime.me = 99
        val carol = com.openmychat.mobile.testing.FakeSessionRepository(99)
        val scope = CoroutineScope(main.dispatcher)
        val seen = mutableListOf<Long>()
        var holder: DeliveryEngine? = null
        // A collector is conflated: the clock (read at every step) and the link (asked who is signed
        // in) also look at the published model, so a brief emission cannot slip through.
        val watch = { holder?.state?.value?.messages?.values?.flatten()?.forEach { seen += it.id } }
        val link = object : DeliveryLink by RealtimeDeliveryLink(realtime, carol) {
            override fun authenticatedUserId(): Long? {
                watch()
                return 99
            }
        }
        val engine = DeliveryEngine(scope, store, link, FakeDeliveryBackend(), clock = { watch(); 0L })
        scope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
            engine.state.collect { s -> s.messages.values.flatten().forEach { seen += it.id } }
        }

        holder = engine
        engine.start()
        engine.awaitReady()

        assertTrue("never emitted: $seen", 400L !in seen)
        assertTrue(store.stored.cache.isEmpty())
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

    @Test
    fun aColdStartSignedInAsAnotherAccountNeverShowsThePreviousAccountsQueue() = runBlocking {
        // Fix round 4: the app's own wiring (DeliveryRuntime.create, used by DI) and its real start
        // path — whoever asks the graph first starts the engine, then the app starts the runtime.
        // Боб's store, Кэрол signed in, no socket yet (the usual cold start).
        val store = InMemoryDeliveryStore()
        store.persist(listOf("cancelled", "cursor", "ops", "outbox"), DeliveryState(me = 2, seq = 1).apply {
            sync.cursor = "b-cursor"
            outbox.add(OutboxEntry(clientMsgId = "k0", conversation = conv, seq = 1, text = "текст Боба"))
        }, mapOf(conv to listOf(DeliveryReducer.project(record(400, "y", "секрет Боба", from = alice, to = 2), null))))
        realtime.connectionState.value = ConnectionState.Connecting
        val carol = com.openmychat.mobile.testing.FakeSessionRepository(99)
        val seen = mutableSetOf<String>()
        var holder: DeliveryEngine? = null
        val watch = {
            holder?.state?.value?.let { s ->
                s.outbox.forEach { seen += it.clientMsgId }
                s.messages.values.flatten().forEach { seen += "${it.id}" }
            }
            Unit
        }
        val scope = CoroutineScope(main.dispatcher)
        val runtime = DeliveryRuntime.create(
            scope, store, com.openmychat.mobile.testing.InMemoryUploadStore(), RealtimeDeliveryLink(realtime, carol),
            FakeDeliveryBackend(), com.openmychat.mobile.data.repository.UnavailableAttachments, carol, realtime, {},
            clock = { watch(); 0L }
        )
        holder = runtime.engine
        scope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { runtime.engine.state.collect { watch() } }

        runtime.engine.start() // the first to ask the DI graph
        runtime.start() // CentyChatApp.onCreate
        runtime.engine.awaitReady()

        assertTrue("nothing of Боб was ever emitted: $seen", "k0" !in seen && "400" !in seen)
        assertTrue(store.stored.outbox.isEmpty())
        assertTrue(store.stored.cache.isEmpty())
        assertEquals(99L, runtime.engine.state.value.me)
    }

    /** A store whose owner cannot be written while [failOwner] is set. */
    private class OwnerFailingStore : InMemoryDeliveryStore() {
        var failOwner = false
        override suspend fun setOwner(me: Long) {
            if (failOwner) throw java.io.IOException("read-only")
            super.setOwner(me)
        }
    }

    @Test
    fun anEnqueueThatNamesItsAccountAfterAnOwnerWriteFailedIsTaken() = runBlocking {
        // Fix round 4 (3): a successful claim proceeds — the entry is stored under its account.
        val store = OwnerFailingStore().apply { failOwner = true }
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)
        store.failOwner = false

        val outcome = h.engine.enqueue(conv, "после сбоя", clientMsgId = "k1")

        assertTrue("taken, the composer clears", outcome.composerCleared)
        assertEquals(listOf("k1"), store.stored.outbox.map { it.clientMsgId })
        assertEquals("stored under its account", 1L, store.stored.me)
    }

    @Test
    fun anEnqueueWhoseAccountCannotBeWrittenIsRefusedAndRetriedNeverStoredUnowned() = runBlocking {
        // Fix round 4 (3): a failed claim refuses the enqueue (the composer keeps the text, the screen
        // says it was not saved) and the engine retries the claim; nothing is stored without an owner.
        val store = OwnerFailingStore().apply { failOwner = true }
        realtime.connectionState.value = ConnectionState.Connecting
        val h = harness(store)

        val outcome = h.engine.enqueue(conv, "без владельца", clientMsgId = "k1")

        assertFalse("refused: the composer keeps the text", outcome.persisted)
        assertFalse(outcome.composerCleared)
        assertTrue("nothing stored without its account", store.stored.outbox.isEmpty())
        assertTrue(h.engine.state.value.outbox.isEmpty())

        store.failOwner = false
        elapse(1_000) // the claim is retried
        assertEquals(1L, h.engine.state.value.me)
        assertEquals(1L, store.stored.me)
        assertTrue(h.engine.enqueue(conv, "теперь можно", clientMsgId = "k2").composerCleared)
        assertEquals(listOf("k2"), store.stored.outbox.map { it.clientMsgId })
    }

    @Test
    fun aFileIsNeverUploadedWhileTheQueueNamesNoAccount() = runBlocking {
        // Fix round 4 (4): a listed file goes up only when the model and the disk both name the
        // signed-in account — never while the queue names nobody (as during a wipe).
        val uploads = com.openmychat.mobile.testing.InMemoryUploadStore()
        uploads.put(com.openmychat.mobile.data.delivery.PendingUpload("k9", conv, 0, "отчёт.pdf", 2048, "application/pdf", null, null, "content://docs/9", null))
        val store = InMemoryDeliveryStore(uploads)
        val files = com.openmychat.mobile.testing.FakeAttachmentRepository()
        realtime.connectionState.value = ConnectionState.Connecting
        val scope = CoroutineScope(main.dispatcher)
        val engine = DeliveryEngine(scope, store, RealtimeDeliveryLink(realtime, com.openmychat.mobile.testing.FakeSessionRepository(99)), FakeDeliveryBackend(), clock = { 0L })
        engine.start()
        engine.awaitReady()
        assertNull("the queue names no account", engine.state.value.me)
        val sends = com.openmychat.mobile.features.chat.AttachmentSends(scope, uploads, files, engine, { 0L }, owner = { 99L })
        sends.start(kotlinx.coroutines.flow.flowOf(true))

        sends.flush()

        assertTrue("never under Кэрол's token: ${files.uploads}", files.uploads.isEmpty())
    }

    @Suppress("unused")
    private fun JsonObject.str(key: String) = (this[key] as? JsonPrimitive)?.content
}
