package com.openmychat.mobile.features.conversations

import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.data.realtime.ConversationRef
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import com.openmychat.mobile.testing.message
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class ConversationsViewModelRealtimeTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val alice = 7L
    private val bob = 8L
    private val channelId = 3L
    private val realtime = FakeRealtimeRepository()
    private val registry = ActiveConversationRegistry()
    private val chats = FakeChatRepository(
        direct = listOf(
            DirectConversation(userId = alice, fullName = "Alice", unreadCount = 0),
            DirectConversation(userId = bob, fullName = "Bob", unreadCount = 3)
        ),
        channels = listOf(Channel(id = channelId, name = "mobile-dev", unreadCount = 0))
    )
    private lateinit var viewModel: ConversationsViewModel

    @Before
    fun createViewModel() {
        // Created after MainDispatcherRule has installed the test Main dispatcher.
        viewModel = ConversationsViewModel(chats, realtime, FakeSessionRepository(), registry)
    }

    private val content get() = viewModel.uiState.value as ConversationsUiState.Content
    private fun unreadOf(userId: Long) = content.directConversations.single { it.userId == userId }.unreadCount
    private val channelUnread get() = content.channels.single { it.id == channelId }.unreadCount

    @Test
    fun incomingDirectMessageInAClosedConversationCountsOnce() {
        realtime.emit(WsEvent.NewMessage(message(id = 1, from = alice, to = ME)))

        assertEquals(1, unreadOf(alice))
        assertEquals("text 1", content.directConversations.single { it.userId == alice }.lastMessageText)
    }

    @Test
    fun ownChannelMessageIsNotUnread() {
        realtime.emit(WsEvent.NewMessage(message(id = 2, from = ME, to = channelId, type = ConversationType.CHANNEL)))

        assertEquals(0, channelUnread)
        assertEquals("text 2", content.channels.single().lastMessageText)
    }

    @Test
    fun othersChannelMessageInAClosedChannelIsUnread() {
        realtime.emit(WsEvent.NewMessage(message(id = 3, from = alice, to = channelId, type = ConversationType.CHANNEL)))

        assertEquals(1, channelUnread)
    }

    @Test
    fun messagesInTheOpenConversationAreNotUnread() {
        registry.enter(ConversationRef(ConversationType.DIRECT, alice))
        realtime.emit(WsEvent.NewMessage(message(id = 4, from = alice, to = ME)))
        assertEquals(0, unreadOf(alice))

        registry.enter(ConversationRef(ConversationType.CHANNEL, channelId))
        realtime.emit(WsEvent.NewMessage(message(id = 5, from = alice, to = channelId, type = ConversationType.CHANNEL)))
        assertEquals(0, channelUnread)
    }

    @Test
    fun openingAConversationClearsItsUnreadCount() {
        assertEquals(3, unreadOf(bob))

        registry.enter(ConversationRef(ConversationType.DIRECT, bob))

        assertEquals(0, unreadOf(bob))
    }

    @Test
    fun aMessageFromSomeoneNotInTheListReloadsConversations() {
        val requestsBefore = chats.directConversationRequests

        realtime.emit(WsEvent.NewMessage(message(id = 6, from = 99, to = ME)))

        assertEquals(requestsBefore + 1, chats.directConversationRequests)
    }
}
