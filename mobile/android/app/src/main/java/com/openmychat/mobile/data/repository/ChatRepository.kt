package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.model.Message
import javax.inject.Inject
import javax.inject.Singleton

interface ChatRepository {
    suspend fun directConversations(): List<DirectConversation>
    suspend fun channels(): List<Channel>

    /** Caches the server's edit/delete windows in the session. */
    suspend fun refreshServerInfo()
    suspend fun messages(conversationType: ConversationType, targetId: Long): List<Message>
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
}
