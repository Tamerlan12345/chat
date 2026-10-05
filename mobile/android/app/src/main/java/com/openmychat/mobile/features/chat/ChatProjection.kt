package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.delivery.DeliveryState
import com.openmychat.mobile.data.delivery.Msg
import com.openmychat.mobile.data.delivery.Op
import com.openmychat.mobile.data.delivery.OutboxEntry
import com.openmychat.mobile.data.delivery.toRecord
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DeliveryStatus
import com.openmychat.mobile.data.model.LocalUpload
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageMetadata
import com.openmychat.mobile.data.model.MessageType
import com.openmychat.mobile.data.model.SendState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import java.time.Instant

/**
 * What the chat shows (delivery-state.md §3.4): the conversation's messages by id without those the
 * user is deleting (a `delete` op hides them until the tombstone), then its outbox entries by seq
 * without cancelled ones (text `pending_edit ?: text`), then files still going up. A row keeps its
 * identity across confirmation: `client_msg_id` when there is one.
 */
class ChatProjection(
    private val conversationType: ConversationType,
    private val targetId: Long
) {
    /** Decoded server records, reused while the model's message is unchanged. */
    private val decoded = HashMap<Long, Pair<Msg, Message>>()

    /** When this device first showed an unsent message (the outbox keeps no time). */
    private val firstSeen = LocalSendTimes

    fun build(
        state: DeliveryState,
        conversation: String,
        me: Long,
        myName: String,
        uploads: List<AttachmentSends.Upload>,
        handedOver: Map<String, LocalUpload>
    ): List<Message> {
        val deleting = state.ops.filter { it.op == Op.DELETE }.mapNotNullTo(HashSet()) { it.messageId }
        val server = state.messages[conversation].orEmpty()
        val keys = HashSet<String>()
        val result = ArrayList<Message>(server.size + state.outbox.size + uploads.size)
        val alive = HashSet<Long>()
        for (msg in server) {
            alive += msg.id
            if (msg.id in deleting) continue
            msg.clientMsgId?.let(keys::add)
            result += decode(msg)
        }
        decoded.keys.retainAll(alive)
        for (entry in state.outbox) {
            if (entry.conversation != conversation || entry.pendingDelete) continue
            keys += entry.clientMsgId
            result += local(entry, me, myName, handedOver[entry.clientMsgId])
        }
        for (upload in uploads) {
            val pending = upload.pending
            if (pending.conversation != conversation || pending.clientMsgId in keys) continue
            result += Message(
                id = localId(pending.clientMsgId),
                conversationType = conversationType,
                targetId = targetId,
                senderId = me,
                text = pending.name,
                type = if (com.openmychat.mobile.features.attachments.Attachments.isImage(pending.name, pending.mimeType)) MessageType.IMAGE else MessageType.FILE,
                replyToId = pending.replyToId,
                createdAt = Instant.ofEpochMilli(pending.createdAt).toString(),
                senderName = myName,
                clientMsgId = pending.clientMsgId,
                sendState = when {
                    pending.failed -> SendState.FAILED
                    upload.progress != null -> SendState.SENDING
                    else -> SendState.QUEUED
                },
                upload = upload.toLocalUpload()
            )
        }
        return withReplies(result)
    }

    private fun decode(msg: Msg): Message {
        decoded[msg.id]?.let { (seen, message) -> if (seen == msg) return message }
        val record = msg.toRecord()
        val base = runCatching { json.decodeFromJsonElement<Message>(record) }.getOrNull() ?: Message(
            id = msg.id,
            conversationType = conversationType,
            targetId = targetId,
            senderId = msg.senderId,
            text = msg.text,
            createdAt = msg.createdAt.orEmpty()
        )
        val deleted = msg.isDeleted == 1
        val message = base.copy(
            text = msg.text,
            type = MessageType.fromValue(msg.type),
            replyToId = msg.replyToId,
            metadataJson = msg.metadataJson,
            metadata = if (deleted) null else base.metadata,
            createdAt = msg.createdAt ?: base.createdAt,
            updatedAt = msg.updatedAt,
            isDeleted = deleted,
            fileOriginalName = if (deleted) null else base.fileOriginalName,
            clientMsgId = msg.clientMsgId,
            deliveryStatus = when (msg.status) {
                "read" -> DeliveryStatus.READ
                "delivered" -> DeliveryStatus.DELIVERED
                else -> null
            },
            sendState = SendState.SENT,
            upload = null
        )
        decoded[msg.id] = msg to message
        return message
    }

    private fun local(entry: OutboxEntry, me: Long, myName: String, upload: LocalUpload?) = Message(
        id = localId(entry.clientMsgId),
        conversationType = conversationType,
        targetId = targetId,
        senderId = me,
        text = entry.pendingEdit ?: entry.text,
        type = MessageType.fromValue(entry.msgType),
        replyToId = entry.replyToId,
        metadataJson = entry.metadata?.toString(),
        createdAt = firstSeen.of(entry.clientMsgId),
        senderName = myName,
        clientMsgId = entry.clientMsgId,
        sendState = when (entry.state) {
            OutboxEntry.SENDING -> SendState.SENDING
            OutboxEntry.FAILED -> SendState.FAILED
            else -> SendState.QUEUED
        },
        upload = upload
    )

    /** A reply shows its quote (desktop ChatView: the original found among the loaded messages). */
    private fun withReplies(messages: List<Message>): List<Message> {
        if (messages.none { it.replyToId != null }) return messages
        val byId = messages.associateBy { it.id }
        return messages.map { message ->
            val replyTo = message.replyToId ?: return@map message
            if (message.isDeleted || message.metadata?.replyText != null) return@map message
            val original = byId[replyTo]?.takeIf { !it.isDeleted && it.text.isNotBlank() } ?: return@map message
            message.copy(metadata = (message.metadata ?: MessageMetadata()).copy(replyText = original.text, replySenderName = original.senderName))
        }
    }

    companion object {
        private val json = Json {
            ignoreUnknownKeys = true
            coerceInputValues = true
        }
        private val encoder = Json { encodeDefaults = true }

        /** A stable negative id for a message the server has not numbered yet. */
        fun localId(clientMsgId: String): Long = -((clientMsgId.hashCode().toLong() and 0x7fffffffL) + 1)

        /** A server message as the delivery model's record (`history_page`). */
        fun record(message: Message): JsonObject = encoder.encodeToJsonElement(message).jsonObject
    }
}

/** First time each unsent message was shown in this process (the bubble's time until the server's). */
object LocalSendTimes {
    private val times = HashMap<String, String>()

    @Synchronized
    fun of(clientMsgId: String): String = times.getOrPut(clientMsgId) { Instant.now().toString() }
}
