package com.openmychat.mobile.data.delivery.store

import com.openmychat.mobile.data.delivery.DeliveryState
import com.openmychat.mobile.data.delivery.DeliveryStore
import com.openmychat.mobile.data.delivery.Failure
import com.openmychat.mobile.data.delivery.Msg
import com.openmychat.mobile.data.delivery.Op
import com.openmychat.mobile.data.delivery.OutboxEntry
import com.openmychat.mobile.data.delivery.PendingUpload
import com.openmychat.mobile.data.delivery.StoredDelivery
import com.openmychat.mobile.data.delivery.UploadStore
import com.openmychat.mobile.data.delivery.toRecord
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** [DeliveryStore] over Room: each `persist` is one SQLite transaction (durable when it returns). */
class RoomDeliveryStore(private val dao: DeliveryDao) : DeliveryStore {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun load(): StoredDelivery {
        val meta = dao.meta().associate { it.key to it.value }
        val cache = LinkedHashMap<String, MutableList<JsonObject>>()
        for (row in dao.cachedMessages()) {
            val record = runCatching { json.parseToJsonElement(row.record) as? JsonObject }.getOrNull() ?: continue
            cache.getOrPut(row.conversation) { ArrayList() } += record
        }
        return StoredDelivery(
            me = meta[ME]?.toLongOrNull(),
            cursor = meta[CURSOR],
            seq = meta[SEQ]?.toLongOrNull() ?: 0,
            outbox = dao.outbox().map { it.toEntry() },
            ops = dao.ops().map { it.toOp() },
            cancelled = dao.cancelled().map { it.clientMsgId },
            cache = cache
        )
    }

    override suspend fun persist(slices: List<String>, state: DeliveryState, cache: Map<String, List<Msg>>) {
        val meta = buildList {
            add(MetaRow(ME, state.me?.toString()))
            if ("cursor" in slices) add(MetaRow(CURSOR, state.sync.cursor))
            if ("outbox" in slices) add(MetaRow(SEQ, state.seq.toString()))
        }
        dao.persist(
            outbox = if ("outbox" in slices) state.outbox.map { it.toRow() } else null,
            ops = if ("ops" in slices) state.ops.mapIndexed { i, op -> op.toRow(i) } else null,
            cancelled = if ("cancelled" in slices) state.cancelled.mapIndexed { i, key -> CancelledKeyRow(i, key) } else null,
            meta = meta,
            cache = cacheRows(cache)
        )
    }

    override suspend fun setOwner(me: Long) = dao.putMeta(listOf(MetaRow(ME, me.toString())))

    override suspend fun writeCache(cache: Map<String, List<Msg>>) = dao.writeCache(cacheRows(cache))

    override suspend fun clear() = dao.clearAll()

    private fun cacheRows(cache: Map<String, List<Msg>>): Map<String, List<CachedMessageRow>> =
        cache.mapValues { (conversation, list) ->
            list.takeLast(DeliveryStore.CACHE_PER_CONVERSATION).map { CachedMessageRow(it.id, conversation, it.toRecord().toString()) }
        }

    private fun OutboxEntry.toRow() = OutboxRow(
        clientMsgId = clientMsgId,
        conversation = conversation,
        seq = seq,
        text = text,
        msgType = msgType,
        replyToId = replyToId,
        metadata = metadata?.toString(),
        state = state,
        attempts = attempts,
        failures = failures,
        maybeStored = maybeStored,
        transport = transport,
        ackDeadline = ackDeadline,
        nextAttemptAt = nextAttemptAt,
        failureReason = failure?.reason,
        failureCode = failure?.code,
        failureMessage = failure?.message,
        pendingEdit = pendingEdit,
        pendingDelete = pendingDelete
    )

    private fun OutboxRow.toEntry() = OutboxEntry(
        clientMsgId = clientMsgId,
        conversation = conversation,
        seq = seq,
        text = text,
        msgType = msgType,
        replyToId = replyToId,
        metadata = metadata?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() },
        state = state,
        attempts = attempts,
        failures = failures,
        maybeStored = maybeStored,
        transport = transport,
        ackDeadline = ackDeadline,
        nextAttemptAt = nextAttemptAt,
        failure = failureReason?.let { Failure(it, failureCode, failureMessage) },
        pendingEdit = pendingEdit,
        pendingDelete = pendingDelete
    )

    private fun Op.toRow(position: Int) = OpRow(position, op, messageId, clientMsgId, text, state, attempts, failures, ackDeadline, nextAttemptAt)

    private fun OpRow.toOp() = Op(op, messageId, clientMsgId, text, state, attempts, failures, ackDeadline, nextAttemptAt)

    private companion object {
        const val ME = "me"
        const val CURSOR = "cursor"
        const val SEQ = "seq"
    }
}

class RoomUploadStore(private val dao: DeliveryDao) : UploadStore {
    override suspend fun all(): List<PendingUpload> = dao.pendingUploads().map {
        PendingUpload(it.clientMsgId, it.conversation, it.createdAt, it.name, it.size, it.mimeType, it.width, it.height, it.uri, it.replyToId, it.failed, it.error)
    }

    override suspend fun put(upload: PendingUpload) = dao.putUpload(
        PendingUploadRow(
            upload.clientMsgId, upload.conversation, upload.createdAt, upload.name, upload.size, upload.mimeType,
            upload.width, upload.height, upload.uri, upload.replyToId, upload.failed, upload.error
        )
    )

    override suspend fun remove(clientMsgId: String) = dao.removeUpload(clientMsgId)

    override suspend fun clear() = dao.clearUploads()
}
