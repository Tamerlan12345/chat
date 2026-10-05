package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.features.chat.HistoryWindow
import javax.inject.Inject
import javax.inject.Singleton

interface ChatRepository {
    suspend fun directConversations(): List<DirectConversation>
    suspend fun channels(): List<Channel>

    /** Caches the server's edit/delete windows in the session. */
    suspend fun refreshServerInfo()
    suspend fun messages(conversationType: ConversationType, targetId: Long): List<Message>

    /** История вокруг сообщения до последнего ([HistoryWindow]); null — слишком давнее или удалено. */
    suspend fun messagesAround(conversationType: ConversationType, targetId: Long, messageId: Long): List<Message>? = null

    /** Поиск по сообщениям, доступным сотруднику (сервер: до 30 последних совпадений). */
    suspend fun searchMessages(query: String): List<Message> = emptyList()

    /** The page of [PAGE_SIZE] messages before [beforeId] (`beforeId`), oldest first. */
    suspend fun messagesBefore(conversationType: ConversationType, targetId: Long, beforeId: Long): List<Message> = emptyList()

    companion object {
        /** Messages per history page (the server's default `limit`). */
        const val PAGE_SIZE = 50
    }
}

@Singleton
class DefaultChatRepository @Inject constructor(
    private val apiClient: ApiClient
) : ChatRepository {
    override suspend fun directConversations(): List<DirectConversation> = apiClient.getDirectConversations()
    override suspend fun channels(): List<Channel> = apiClient.getChannels()
    override suspend fun refreshServerInfo() {
        apiClient.getServerInfo()
    }

    override suspend fun messages(conversationType: ConversationType, targetId: Long): List<Message> =
        if (conversationType == ConversationType.DIRECT) {
            apiClient.getDirectMessages(targetId)
        } else {
            apiClient.getChannelMessages(targetId)
        }

    override suspend fun messagesAround(conversationType: ConversationType, targetId: Long, messageId: Long): List<Message>? =
        HistoryWindow.around(
            messageId,
            before = { beforeId, limit ->
                if (conversationType == ConversationType.DIRECT) apiClient.getDirectMessages(targetId, beforeId = beforeId, limit = limit)
                else apiClient.getChannelMessages(targetId, beforeId = beforeId, limit = limit)
            },
            after = { afterId, limit ->
                if (conversationType == ConversationType.DIRECT) apiClient.getDirectMessages(targetId, limit = limit, afterId = afterId)
                else apiClient.getChannelMessages(targetId, limit = limit, afterId = afterId)
            }
        )

    override suspend fun searchMessages(query: String): List<Message> = apiClient.searchMessages(query)

    override suspend fun messagesBefore(conversationType: ConversationType, targetId: Long, beforeId: Long): List<Message> =
        if (conversationType == ConversationType.DIRECT) apiClient.getDirectMessages(targetId, beforeId = beforeId, limit = ChatRepository.PAGE_SIZE)
        else apiClient.getChannelMessages(targetId, beforeId = beforeId, limit = ChatRepository.PAGE_SIZE)
}
