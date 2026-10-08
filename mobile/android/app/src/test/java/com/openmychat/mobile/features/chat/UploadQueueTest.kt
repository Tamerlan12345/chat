package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.delivery.DeliveryEngine
import com.openmychat.mobile.data.delivery.DeliveryRuntime
import com.openmychat.mobile.data.delivery.RealtimeDeliveryLink
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.repository.PickedFile
import com.openmychat.mobile.testing.DeliveryHarness
import com.openmychat.mobile.testing.FakeAttachmentRepository
import com.openmychat.mobile.testing.FakeDeliveryBackend
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.InMemoryDeliveryStore
import com.openmychat.mobile.testing.InMemoryUploadStore
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Final review I2 / M1 / M4, parity P1–P3: files go up at most two at a time (the server's limit),
 * wait instead of failing on a temporary refusal, enter the outbox in the order they were picked,
 * a cancelled file is never sent, and a stale screen never adds a file for the next account.
 */
class UploadQueueTest {

    @get:Rule val main = MainDispatcherRule()

    private val conv = "direct:7"
    private val realtime = FakeRealtimeRepository()
    private val files = FakeAttachmentRepository()
    private val delivery = DeliveryHarness(realtime, null, main.dispatcher, files = files)
    private val sends get() = delivery.sends
    private val notices = mutableListOf<String>()

    init {
        CoroutineScope(main.dispatcher).launch { sends.notices.collect { notices += it.second } }
    }

    private fun file(n: Int) = PickedFile("content://docs/$n", "файл-$n.pdf", 1024, "application/pdf")

    private fun elapse(ms: Long) {
        main.dispatcher.scheduler.advanceTimeBy(ms)
        main.dispatcher.scheduler.runCurrent()
    }

    private val fileFrames get() = realtime.sent.filter { it.startsWith("send_message") }
    private val waiting get() = sends.uploads.value
    private val outboxTexts get() = delivery.engine.state.value.outbox.map { it.text }

    // ── I2 / P1: two at a time ─────────────────────────────────────────────────────────────────

    @Test
    fun threeFilesQueuedOfflineGoUpTwoAtATimeInTheOrderTheyWerePicked() = runBlocking {
        realtime.connectionState.value = ConnectionState.Connecting
        (1..3).forEach { n ->
            files.gates[file(n).name] = CompletableDeferred()
            assertTrue(sends.add(conv, file(n), null))
        }

        realtime.connectionState.value = ConnectionState.Connected

        assertEquals("the server allows two uploads per person", listOf(file(1), file(2)), files.uploads)
        assertEquals(2, files.maxActive)
        files.gates[file(1).name]!!.complete(files.uploaded(file(1)))
        assertEquals("a free slot takes the next file", listOf(file(1), file(2), file(3)), files.uploads)
        files.gates[file(2).name]!!.complete(files.uploaded(file(2)))
        files.gates[file(3).name]!!.complete(files.uploaded(file(3)))

        assertEquals(2, files.maxActive)
        assertEquals("all three are in the outbox, in order", listOf("файл-1.pdf", "файл-2.pdf", "файл-3.pdf"), outboxTexts)
        assertTrue(waiting.isEmpty())
    }

    // ── I2 / P2: a temporary refusal is a wait ─────────────────────────────────────────────────

    @Test
    fun aRateLimitWithRetryAfterKeepsTheFileQueuedAndGoesAgainAfterTheWait() = runBlocking {
        files.uploadFailure = ApiException(429, "RATE_LIMITED", "Дождитесь окончания текущих загрузок", retryAfterSeconds = 20)
        assertTrue(sends.add(conv, file(1), null))

        val queued = waiting.single()
        assertFalse("not refused", queued.pending.failed)
        assertEquals(null, queued.progress)
        assertTrue("no failure notice", notices.isEmpty())

        elapse(19_999)
        assertEquals(1, files.uploads.size)
        elapse(1)
        assertEquals("goes again once the server's wait is over", 2, files.uploads.size)
        assertEquals(1, fileFrames.size)
    }

    @Test
    fun serverTroubleAndAnExpiredSessionAreWaitsNotRefusals() = runBlocking {
        for ((status, code) in listOf(408 to null, 500 to null, 503 to "BUSY", 507 to "INSUFFICIENT_STORAGE", 401 to "UNAUTHORIZED")) {
            files.uploads.clear()
            files.uploadFailure = ApiException(status, code, "временно")
            val n = status
            assertTrue(sends.add(conv, file(n), null))
            val upload = waiting.single { it.pending.name == file(n).name }
            assertFalse("$status must not fail the file", upload.pending.failed)
        }
    }

    @Test
    fun aFileThatKeepsMeetingServerTroubleIsFailedAfterTheAttemptCap() = runBlocking {
        // Five temporary refusals in a row: the person decides now («Повторить» / «Удалить»).
        files.failEvery = ApiException(503, null, "Сервер перегружен")
        assertTrue(sends.add(conv, file(1), null))
        repeat(10) { elapse(15_000) }

        val failed = waiting.single()
        assertTrue(failed.pending.failed)
        assertEquals("Сервер перегружен", failed.pending.error)
        assertEquals("tried five times", 5, files.uploads.size)
        assertEquals(listOf("Сервер перегружен"), notices)
    }

    @Test
    fun aRefusalOfTheFileItselfStillFailsIt() = runBlocking {
        files.uploadFailure = ApiException(413, "FILE_TOO_LARGE", "Файл больше 100 МБ — такой файл загрузить нельзя")
        assertTrue(sends.add(conv, file(1), null))
        assertTrue(waiting.single().pending.failed)
    }

    // ── P3: the outbox gets the files in the order they were picked ─────────────────────────────

    @Test
    fun aLaterFileThatFinishesFirstWaitsForTheEarlierOne() = runBlocking {
        files.gates[file(1).name] = CompletableDeferred()
        files.gates[file(2).name] = CompletableDeferred()
        assertTrue(sends.add(conv, file(1), null))
        assertTrue(sends.add(conv, file(2), null))

        files.gates[file(2).name]!!.complete(files.uploaded(file(2)))
        assertEquals("the second file waits for the first", emptyList<String>(), fileFrames)

        assertEquals(emptyList<String>(), outboxTexts)

        files.gates[file(1).name]!!.complete(files.uploaded(file(1)))
        assertEquals("picked order, not finishing order", listOf("файл-1.pdf", "файл-2.pdf"), outboxTexts)
    }

    @Test
    fun aRefusedEarlierFileDoesNotHoldUpTheLaterOnes() = runBlocking {
        files.gates[file(2).name] = CompletableDeferred()
        files.uploadFailure = ApiException(413, null, "слишком большой")
        assertTrue(sends.add(conv, file(1), null)) // refused at once
        assertTrue(sends.add(conv, file(2), null))

        files.gates[file(2).name]!!.complete(files.uploaded(file(2)))

        assertEquals(listOf("файл-2.pdf"), outboxTexts)
    }

    // ── M4: a stale screen never adds a file for the next account ──────────────────────────────

    @Test
    fun aFileAddedForAnAccountThatIsNoLongerSignedInIsRefused() = runBlocking {
        delivery.session.currentUser.value = User(id = 99, username = "carol", fullName = "Кэрол")
        realtime.me = 99

        assertFalse(sends.add(conv, file(1), null, screenAccount = FakeSessionRepository.ME))
        assertTrue(files.kept.isEmpty())
        assertTrue(files.uploads.isEmpty())
    }
}

/**
 * M1: «Отменить» pressed after the upload returned, while the file message waits for the delivery
 * engine, is never sent. The engine and the file queue run on separate dispatchers here so the test
 * decides what each has run.
 */
class UploadCancelRaceTest {

    @get:Rule val main = MainDispatcherRule()

    private val realtime = FakeRealtimeRepository()
    private val session = FakeSessionRepository()
    private val files = FakeAttachmentRepository()
    private val uploads = InMemoryUploadStore()
    private val store = InMemoryDeliveryStore(uploads)
    private val engineScheduler = TestCoroutineScheduler()
    private val sendsScheduler = TestCoroutineScheduler()
    private val engineScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(engineScheduler))
    private val sendsScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(sendsScheduler))
    private val engine = DeliveryEngine(engineScope, store, RealtimeDeliveryLink(realtime, session), FakeDeliveryBackend(), { 0L }, signedInNow = { session.currentUserId })
    private val sends = AttachmentSends(sendsScope, uploads, files, engine, { 0L }, owner = { session.currentUserId })
    private val runtime = DeliveryRuntime(engine, sends, session, realtime, engineScope, {}, { _, _ -> })

    private fun settle() = repeat(5) {
        engineScheduler.runCurrent()
        sendsScheduler.runCurrent()
    }

    @Test
    fun cancellingWhileTheUploadedFileWaitsForTheEngineNeverSendsIt() = runBlocking {
        runtime.start()
        settle()
        val pdf = PickedFile("content://docs/1", "отчёт.pdf", 2048, "application/pdf")
        files.gates[pdf.name] = CompletableDeferred()
        var added = false
        sendsScope.launch { added = sends.add("direct:7", pdf, null) }
        settle()
        assertTrue(added)
        assertEquals(1, files.uploads.size)

        files.gates[pdf.name]!!.complete(files.uploaded(pdf))
        sendsScheduler.runCurrent() // the upload returned; the file message now waits for the engine
        val key = sends.uploads.value.single().pending.clientMsgId
        sends.cancel(key)
        settle()

        assertTrue("a cancelled file is never sent: ${realtime.sent}", realtime.sent.none { it.startsWith("send_message") })
        assertTrue(engine.state.value.outbox.none { it.clientMsgId == key && !it.pendingDelete })
        engineScope.cancel()
        sendsScope.cancel()
    }
}
