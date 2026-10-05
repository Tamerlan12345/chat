package com.openmychat.mobile.testing

import com.openmychat.mobile.data.delivery.DeliveryState
import com.openmychat.mobile.data.delivery.DeliveryStore
import com.openmychat.mobile.data.delivery.Msg
import com.openmychat.mobile.data.delivery.PendingUpload
import com.openmychat.mobile.data.delivery.StoredDelivery
import com.openmychat.mobile.data.delivery.UploadStore
import com.openmychat.mobile.data.delivery.toRecord
import kotlinx.serialization.json.JsonObject

/** For tests and previews: nothing survives the process. */
/** [uploads] — the file rows that live in the same database in the app (a wipe clears them too). */
open class InMemoryDeliveryStore(private val uploads: InMemoryUploadStore? = null) : DeliveryStore {
    var stored = StoredDelivery()
        private set
    var failNextPersist: Exception? = null
    val persisted = mutableListOf<List<String>>()

    override suspend fun load(): StoredDelivery = stored

    override suspend fun persist(slices: List<String>, state: DeliveryState, cache: Map<String, List<Msg>>) {
        failNextPersist?.let {
            failNextPersist = null
            throw it
        }
        persisted += slices
        stored = StoredDelivery(
            me = state.me,
            cursor = if ("cursor" in slices) state.sync.cursor else stored.cursor,
            seq = if ("outbox" in slices) state.seq else stored.seq,
            outbox = if ("outbox" in slices) state.outbox.map { it.copy() } else stored.outbox,
            ops = if ("ops" in slices) state.ops.map { it.copy() } else stored.ops,
            cancelled = if ("cancelled" in slices) state.cancelled.toList() else stored.cancelled,
            cache = mergeCache(cache)
        )
    }

    override suspend fun writeCache(cache: Map<String, List<Msg>>) {
        stored = StoredDelivery(stored.me, stored.cursor, stored.seq, stored.outbox, stored.ops, stored.cancelled, mergeCache(cache))
    }

    private fun mergeCache(cache: Map<String, List<Msg>>): Map<String, List<JsonObject>> {
        val next = LinkedHashMap(stored.cache)
        cache.forEach { (conv, list) ->
            if (list.isEmpty()) next.remove(conv) else next[conv] = list.takeLast(DeliveryStore.CACHE_PER_CONVERSATION).map { it.toRecord() }
        }
        return next
    }

    override suspend fun setOwner(me: Long) {
        stored = StoredDelivery(me, stored.cursor, stored.seq, stored.outbox, stored.ops, stored.cancelled, stored.cache)
    }

    override suspend fun clear() {
        stored = StoredDelivery()
        uploads?.clear()
    }
}

class InMemoryUploadStore : UploadStore {
    private val rows = LinkedHashMap<String, PendingUpload>()
    override suspend fun all(): List<PendingUpload> = synchronized(rows) { rows.values.sortedBy { it.createdAt } }
    override suspend fun put(upload: PendingUpload) = synchronized(rows) { rows[upload.clientMsgId] = upload }
    override suspend fun remove(clientMsgId: String) {
        synchronized(rows) { rows.remove(clientMsgId) }
    }
    override suspend fun clear() = synchronized(rows) { rows.clear() }
}
