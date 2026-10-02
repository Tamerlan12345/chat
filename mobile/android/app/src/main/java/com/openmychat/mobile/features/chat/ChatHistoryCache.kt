package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.realtime.ConversationRef
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The last history shown per conversation, in memory for this process only, so reopening a chat
 * shows it at once instead of a skeleton. Keyed by the signed-in user: another account never sees
 * it. Not a store: the durable outbox and sync belong to the send queue (Task 15).
 */
@Singleton
class ChatHistoryCache @Inject constructor() {
    private val entries = HashMap<Pair<Long, ConversationRef>, List<Message>>()

    @Synchronized
    fun get(userId: Long, conversation: ConversationRef): List<Message>? = entries[userId to conversation]

    @Synchronized
    fun put(userId: Long, conversation: ConversationRef, messages: List<Message>) {
        // Keep the newest 200: enough for the first screens of a reopened chat.
        entries[userId to conversation] = if (messages.size > 200) messages.takeLast(200) else messages
    }
}
