package com.openmychat.mobile.delivery

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.openmychat.mobile.data.delivery.DeliveryReducer
import com.openmychat.mobile.data.delivery.DeliveryState
import com.openmychat.mobile.data.delivery.Failure
import com.openmychat.mobile.data.delivery.Op
import com.openmychat.mobile.data.delivery.OutboxEntry
import com.openmychat.mobile.data.delivery.PendingUpload
import com.openmychat.mobile.data.delivery.store.DeliveryDatabase
import com.openmychat.mobile.data.delivery.store.RoomDeliveryStore
import com.openmychat.mobile.data.delivery.store.RoomUploadStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The durable slices round-trip through SQLite exactly; the cache and the file queue too; sign-out wipes all. */
@RunWith(AndroidJUnit4::class)
class RoomDeliveryStoreTest {
    private val database = Room.inMemoryDatabaseBuilder(
        InstrumentationRegistry.getInstrumentation().targetContext, DeliveryDatabase::class.java
    ).build()
    private val store = RoomDeliveryStore(database.dao())
    private val uploads = RoomUploadStore(database.dao())

    @After
    fun close() = database.close()

    private fun state() = DeliveryState(me = 2, seq = 3).apply {
        sync.cursor = "5e7a1c0d9b3f4a62.11"
        outbox.add(OutboxEntry(
            clientMsgId = "a0000001-0000-4000-8000-000000000001", conversation = "direct:3", seq = 2, text = "Привет",
            replyToId = 9, metadata = buildJsonObject { put("file_id", 42) }, msgType = "file", state = OutboxEntry.FAILED,
            attempts = 5, failures = 5, maybeStored = true, failure = Failure(Failure.MAX_ATTEMPTS, null, null), pendingEdit = "Привет!"
        ))
        outbox.add(OutboxEntry(clientMsgId = "k2", conversation = "channel:5", seq = 3, text = "второе", nextAttemptAt = 1234))
        ops.add(Op(Op.DELETE, 77, null, null, state = OutboxEntry.SENDING, attempts = 1, ackDeadline = 11000))
        ops.add(Op(Op.CANCEL, null, "k9", null))
        cancelled.addAll(listOf("c1", "c2"))
    }

    @Test
    fun everyPersistedSliceComesBackAsItWasWritten() = runBlocking {
        val written = state()
        store.persist(listOf("cancelled", "cursor", "ops", "outbox"), written, emptyMap())

        val loaded = store.load()

        assertEquals(2L, loaded.me)
        assertEquals("5e7a1c0d9b3f4a62.11", loaded.cursor)
        assertEquals(3L, loaded.seq)
        assertEquals(written.outbox.map { it.toJson() }, loaded.outbox.map { it.toJson() })
        assertEquals(written.ops.map { it.toJson() }, loaded.ops.map { it.toJson() })
        assertEquals(listOf("c1", "c2"), loaded.cancelled)
    }

    @Test
    fun onlyTheNamedSlicesAreRewritten() = runBlocking {
        store.persist(listOf("cancelled", "cursor", "ops", "outbox"), state(), emptyMap())
        val next = state().apply {
            outbox.clear()
            sync.cursor = "later"
        }

        store.persist(listOf("outbox"), next, emptyMap())

        val loaded = store.load()
        assertTrue(loaded.outbox.isEmpty())
        assertEquals("the cursor slice was not named", "5e7a1c0d9b3f4a62.11", loaded.cursor)
        assertEquals(2, loaded.ops.size)
    }

    @Test
    fun theConversationCacheKeepsTheRecordsAndTheirStatus() = runBlocking {
        val record = buildJsonObject {
            put("id", 20)
            put("conversation_type", "direct")
            put("target_id", 3)
            put("sender_id", 2)
            put("text", "Привет")
            put("created_at", "2026-10-02T09:00:01.000Z")
            put("client_msg_id", "k1")
            put("sender_name", "Алиса")
        }
        val msg = DeliveryReducer.project(record, "read")
        store.writeCache(mapOf("direct:3" to listOf(msg)))

        val cached = store.load().cache.getValue("direct:3").single()
        assertEquals("Алиса", cached["sender_name"].toString().trim('"'))
        assertEquals("read", cached["delivery_status"].toString().trim('"'))

        store.writeCache(mapOf("direct:3" to emptyList()))
        assertNull(store.load().cache["direct:3"])
    }

    @Test
    fun waitingFilesSurviveAndSignOutWipesEverything() = runBlocking {
        uploads.put(PendingUpload("k1", "direct:3", 10, "отчёт.pdf", 2048, "application/pdf", null, null, "file:///data/outbox/k1", 9))
        uploads.put(PendingUpload("k2", "direct:3", 20, "фото.jpg", 10, "image/jpeg", 640, 480, "file:///data/outbox/k2", null, failed = true, error = "Сервер не принял файл"))
        store.persist(listOf("cancelled", "cursor", "ops", "outbox"), state(), emptyMap())

        assertEquals(listOf("k1", "k2"), uploads.all().map { it.clientMsgId })
        assertEquals("Сервер не принял файл", uploads.all()[1].error)

        store.clear()

        assertTrue(uploads.all().isEmpty())
        val loaded = store.load()
        assertTrue(loaded.outbox.isEmpty())
        assertNull(loaded.cursor)
        assertNull(loaded.me)
    }
}
