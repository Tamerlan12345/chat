package com.openmychat.mobile.data.delivery.store

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction

/**
 * The durable delivery store (delivery-state.md §5 persist): the outbox, ops, cancelled keys, the
 * sync cursor / seq / me, the conversation cache and the files waiting to go up.
 *
 * Every version's schema is exported to `app/schemas`. The outbox may hold text the user has not
 * sent yet, so this database never falls back to a destructive migration: a version bump ships a
 * migration (and a MigrationTestHelper test against the exported schema).
 */
@Database(
    entities = [
        OutboxRow::class,
        OpRow::class,
        CancelledKeyRow::class,
        MetaRow::class,
        CachedMessageRow::class,
        PendingUploadRow::class
    ],
    version = 1,
    exportSchema = true
)
abstract class DeliveryDatabase : RoomDatabase() {
    abstract fun dao(): DeliveryDao

    companion object {
        const val NAME = "delivery.db"

        fun open(context: Context): DeliveryDatabase =
            Room.databaseBuilder(context.applicationContext, DeliveryDatabase::class.java, NAME)
                // Deliberately no fallbackToDestructiveMigration(): unsent messages are never dropped.
                .build()
    }
}

@Entity(tableName = "outbox")
data class OutboxRow(
    @PrimaryKey @ColumnInfo(name = "client_msg_id") val clientMsgId: String,
    @ColumnInfo(name = "conversation") val conversation: String,
    @ColumnInfo(name = "seq") val seq: Long,
    @ColumnInfo(name = "text") val text: String,
    @ColumnInfo(name = "msg_type") val msgType: String,
    @ColumnInfo(name = "reply_to_id") val replyToId: Long?,
    /** JSON object or null. */
    @ColumnInfo(name = "metadata") val metadata: String?,
    @ColumnInfo(name = "state") val state: String,
    @ColumnInfo(name = "attempts") val attempts: Long,
    @ColumnInfo(name = "failures") val failures: Long,
    @ColumnInfo(name = "maybe_stored") val maybeStored: Boolean,
    @ColumnInfo(name = "transport") val transport: String?,
    @ColumnInfo(name = "ack_deadline") val ackDeadline: Long?,
    @ColumnInfo(name = "next_attempt_at") val nextAttemptAt: Long?,
    @ColumnInfo(name = "failure_reason") val failureReason: String?,
    @ColumnInfo(name = "failure_code") val failureCode: String?,
    @ColumnInfo(name = "failure_message") val failureMessage: String?,
    @ColumnInfo(name = "pending_edit") val pendingEdit: String?,
    @ColumnInfo(name = "pending_delete") val pendingDelete: Boolean
)

@Entity(tableName = "ops")
data class OpRow(
    /** Order of the ops list. */
    @PrimaryKey @ColumnInfo(name = "position") val position: Int,
    @ColumnInfo(name = "op") val op: String,
    @ColumnInfo(name = "message_id") val messageId: Long?,
    @ColumnInfo(name = "client_msg_id") val clientMsgId: String?,
    @ColumnInfo(name = "text") val text: String?,
    @ColumnInfo(name = "state") val state: String,
    @ColumnInfo(name = "attempts") val attempts: Long,
    @ColumnInfo(name = "failures") val failures: Long,
    @ColumnInfo(name = "ack_deadline") val ackDeadline: Long?,
    @ColumnInfo(name = "next_attempt_at") val nextAttemptAt: Long?
)

@Entity(tableName = "cancelled_keys")
data class CancelledKeyRow(
    /** Oldest first. */
    @PrimaryKey @ColumnInfo(name = "position") val position: Int,
    @ColumnInfo(name = "client_msg_id") val clientMsgId: String
)

/** `me`, `cursor`, `seq`. */
@Entity(tableName = "delivery_meta")
data class MetaRow(
    @PrimaryKey @ColumnInfo(name = "key") val key: String,
    @ColumnInfo(name = "value") val value: String?
)

@Entity(tableName = "message_cache", indices = [Index("conversation")])
data class CachedMessageRow(
    @PrimaryKey @ColumnInfo(name = "id") val id: Long,
    @ColumnInfo(name = "conversation") val conversation: String,
    /** The server record as this device knows it (DeliveryStore `toRecord`). */
    @ColumnInfo(name = "record") val record: String
)

@Entity(tableName = "pending_uploads")
data class PendingUploadRow(
    @PrimaryKey @ColumnInfo(name = "client_msg_id") val clientMsgId: String,
    @ColumnInfo(name = "conversation") val conversation: String,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "name") val name: String,
    @ColumnInfo(name = "size") val size: Long?,
    @ColumnInfo(name = "mime_type") val mimeType: String?,
    @ColumnInfo(name = "width") val width: Int?,
    @ColumnInfo(name = "height") val height: Int?,
    @ColumnInfo(name = "uri") val uri: String,
    @ColumnInfo(name = "reply_to_id") val replyToId: Long?,
    @ColumnInfo(name = "failed") val failed: Boolean,
    @ColumnInfo(name = "error") val error: String?
)

@Dao
abstract class DeliveryDao {
    @Query("SELECT * FROM outbox ORDER BY seq")
    abstract suspend fun outbox(): List<OutboxRow>

    @Query("SELECT * FROM ops ORDER BY position")
    abstract suspend fun ops(): List<OpRow>

    @Query("SELECT * FROM cancelled_keys ORDER BY position")
    abstract suspend fun cancelled(): List<CancelledKeyRow>

    @Query("SELECT * FROM delivery_meta")
    abstract suspend fun meta(): List<MetaRow>

    @Query("SELECT * FROM message_cache ORDER BY conversation, id")
    abstract suspend fun cachedMessages(): List<CachedMessageRow>

    @Query("SELECT * FROM pending_uploads ORDER BY created_at")
    abstract suspend fun pendingUploads(): List<PendingUploadRow>

    @Query("DELETE FROM outbox") abstract suspend fun clearOutbox()
    @Query("DELETE FROM ops") abstract suspend fun clearOps()
    @Query("DELETE FROM cancelled_keys") abstract suspend fun clearCancelled()
    @Query("DELETE FROM delivery_meta") abstract suspend fun clearMeta()
    @Query("DELETE FROM message_cache") abstract suspend fun clearCache()
    @Query("DELETE FROM pending_uploads") abstract suspend fun clearUploads()

    @Query("DELETE FROM message_cache WHERE conversation = :conversation")
    abstract suspend fun clearConversation(conversation: String)

    @Query("DELETE FROM pending_uploads WHERE client_msg_id = :clientMsgId")
    abstract suspend fun removeUpload(clientMsgId: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE) abstract suspend fun insertOutbox(rows: List<OutboxRow>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) abstract suspend fun insertOps(rows: List<OpRow>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) abstract suspend fun insertCancelled(rows: List<CancelledKeyRow>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) abstract suspend fun putMeta(rows: List<MetaRow>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) abstract suspend fun insertCache(rows: List<CachedMessageRow>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) abstract suspend fun putUpload(row: PendingUploadRow)

    /** One transaction: the slices that changed (whole lists are small) and the cache of the same step. */
    @Transaction
    open suspend fun persist(
        outbox: List<OutboxRow>?,
        ops: List<OpRow>?,
        cancelled: List<CancelledKeyRow>?,
        meta: List<MetaRow>,
        cache: Map<String, List<CachedMessageRow>>
    ) {
        if (outbox != null) {
            clearOutbox()
            insertOutbox(outbox)
        }
        if (ops != null) {
            clearOps()
            insertOps(ops)
        }
        if (cancelled != null) {
            clearCancelled()
            insertCancelled(cancelled)
        }
        putMeta(meta)
        writeCache(cache)
    }

    @Transaction
    open suspend fun writeCache(cache: Map<String, List<CachedMessageRow>>) {
        for ((conversation, rows) in cache) {
            clearConversation(conversation)
            if (rows.isNotEmpty()) insertCache(rows)
        }
    }

    @Transaction
    open suspend fun clearAll() {
        clearOutbox()
        clearOps()
        clearCancelled()
        clearMeta()
        clearCache()
        clearUploads()
    }
}
