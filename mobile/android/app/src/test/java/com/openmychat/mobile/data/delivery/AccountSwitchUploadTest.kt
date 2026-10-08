package com.openmychat.mobile.data.delivery

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.repository.PickedFile
import com.openmychat.mobile.features.chat.AttachmentSends
import com.openmychat.mobile.testing.FakeAttachmentRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.InMemoryDeliveryStore
import com.openmychat.mobile.testing.InMemoryUploadStore
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Fix round 5: a file of one account never goes up, nor enters the queue, under the next one — even
 * in the moment between the account switch and the file queue forgetting the old files.
 *
 * The engine runs eagerly (unconfined); the file queue runs on its own queued dispatcher, so the
 * test decides what of it has run when the account switches (in the app both share a thread pool
 * and that order is up to the scheduler).
 */
class AccountSwitchUploadTest {

    @get:Rule val main = MainDispatcherRule()

    private val conv = "direct:7"
    private val bob = 2L
    private val carol = 99L
    private val realtime = FakeRealtimeRepository()
    private val session = FakeSessionRepository(bob)
    private val uploads = GatedUploadStore()
    private val store = InMemoryDeliveryStore(uploads.rows) // a wipe clears the rows too
    private val files = FakeAttachmentRepository()
    private val pdf = PickedFile("content://docs/1", "отчёт.pdf", 2048, "application/pdf")

    private val engineScope = CoroutineScope(SupervisorJob() + main.dispatcher)
    private val sendsDispatcher = StandardTestDispatcher(main.dispatcher.scheduler)
    private val sendsScope = CoroutineScope(SupervisorJob() + sendsDispatcher)
    private val clock = { main.dispatcher.scheduler.currentTime }
    private val engine = DeliveryEngine(
        engineScope, store, RealtimeDeliveryLink(realtime, session), com.openmychat.mobile.testing.FakeDeliveryBackend(), clock,
        signedInNow = { session.currentUserId }
    )
    private val sends = AttachmentSends(sendsScope, uploads, files, engine, clock, owner = { session.currentUserId })
    private val runtime = DeliveryRuntime(engine, sends, session, realtime, engineScope, {}, { _, _ -> })

    /** Upload rows whose next read can be held after it has read (a slow disk). */
    class GatedUploadStore(val rows: InMemoryUploadStore = InMemoryUploadStore()) : com.openmychat.mobile.data.delivery.UploadStore {
        var holdNextRead: CompletableDeferred<Unit>? = null
        override suspend fun all(): List<PendingUpload> {
            val read = rows.all()
            holdNextRead?.let {
                holdNextRead = null
                it.await()
            }
            return read
        }
        override suspend fun put(upload: PendingUpload) = rows.put(upload)
        override suspend fun remove(clientMsgId: String) = rows.remove(clientMsgId)
        override suspend fun clear() = rows.clear()
    }

    private fun runSends() = sendsDispatcher.scheduler.runCurrent()

    private val sendFrames get() = realtime.frames.filter { (it["type"] as kotlinx.serialization.json.JsonPrimitive).content == "send_message" }

    private fun start() = runBlocking {
        runtime.start()
        runSends()
        engine.awaitReady()
        runSends()
        assertEquals(bob, engine.state.value.me)
    }

    @After
    fun stop() {
        engineScope.cancel()
        sendsScope.cancel()
    }

    @Test
    fun anUploadThatFinishesAfterTheSwitchNeverEntersTheNextAccountsQueue() = runBlocking {
        files.uploadGate = CompletableDeferred()
        start()
        assertTrue(sends.add(conv, pdf, null))
        runSends() // Боб's file is going up under Боб's token
        assertEquals(1, files.uploads.size)

        files.uploadGate!!.complete(files.uploaded(pdf)) // the answer is on its way back…
        session.currentUser.value = User(id = carol, username = "carol", fullName = "Кэрол") // …and Кэрол signs in
        realtime.me = carol
        assertEquals(carol, engine.state.value.me)
        runSends() // Боб's upload resumes before the file queue forgot it

        assertTrue("nothing of Боб in Кэрол's queue: ${engine.state.value.outbox}", engine.state.value.outbox.isEmpty())
        assertTrue(store.stored.outbox.isEmpty())
        assertTrue(sendFrames.isEmpty())
    }

    @Test
    fun anUploadDispatchedBeforeTheSwitchNeverStartsUnderTheNextAccount() = runBlocking {
        files.uploadFailure = ApiException(413, "FILE_TOO_LARGE", "too large")
        start()
        assertTrue(sends.add(conv, pdf, null))
        runSends() // refused by the server: Боб's file waits for «Повторить»
        files.uploads.clear()

        // Кэрол signs in (a task queued first), and Боб's «Повторить» was pressed just before.
        sendsScope.launch {
            session.currentUser.value = User(id = carol, username = "carol", fullName = "Кэрол")
            realtime.me = carol
        }
        sends.retry(sends.uploads.value.single().pending.clientMsgId)
        runSends()

        assertTrue("Боб's file never goes up under Кэрол's token: ${files.uploads}", files.uploads.isEmpty())
    }

    @Test
    fun aFileAddedWhileTheOldCopiesArePrunedKeepsItsCopy() = runBlocking {
        realtime.connectionState.value = ConnectionState.Connecting // nothing goes up here
        start()
        // A sign-out called off after its delete: the queue is wiped twice and taken again by Боб.
        runtime.discardForSignOut()
        runtime.signOutAborted()
        assertEquals(bob, engine.ownerOnDisk)

        uploads.holdNextRead = CompletableDeferred()
        val hold = uploads.holdNextRead!!
        runSends() // the file queue forgets: it has read the (empty) rows and waits on the disk
        val added = engineScope.async { sends.add(conv, pdf, null) } // Боб attaches a file meanwhile
        hold.complete(Unit)
        runSends()

        assertTrue(added.await())
        val key = uploads.all().single().clientMsgId
        assertTrue("the new file's copy survives the prune: kept=${files.keptNow}", key in files.keptNow)
    }
}
