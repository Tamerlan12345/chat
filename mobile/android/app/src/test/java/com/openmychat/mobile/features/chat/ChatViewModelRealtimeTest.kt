package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.data.realtime.ConversationRef
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import com.openmychat.mobile.testing.message
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

class ChatViewModelRealtimeTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val alice = 7L
    private val realtime = FakeRealtimeRepository()
    private val registry = ActiveConversationRegistry()

    private fun directChat(vararg history: com.openmychat.mobile.data.model.Message) = ChatViewModel(
        conversationType = ConversationType.DIRECT,
        targetId = alice,
        chatRepository = FakeChatRepository(history = history.toList()),
        realtimeRepository = realtime,
        sessionRepository = FakeSessionRepository(),
        activeConversations = registry,
        historyCache = ChatHistoryCache(FakeSessionRepository())
    )

    private val ChatViewModel.messageIds get() = (uiState.value as ChatUiState.Content).messages.map { it.id }

    @Test
    fun peerDeletingTheirMessageRemovesItEvenThoughTargetIdIsTheRecipient() {
        val vm = directChat(message(id = 10, from = alice, to = ME), message(id = 11, from = ME, to = alice))

        // The server sends target_id of the message: for alice's message that is me, not alice.
        realtime.emit(WsEvent.MessageDeleted(messageId = 10, conversationType = "direct", targetId = ME))

        assertEquals(listOf(11L), vm.messageIds)
    }

    @Test
    fun deletingMyOwnMessageRemovesIt() {
        val vm = directChat(message(id = 10, from = alice, to = ME), message(id = 11, from = ME, to = alice))

        realtime.emit(WsEvent.MessageDeleted(messageId = 11, conversationType = "direct", targetId = alice))

        assertEquals(listOf(10L), vm.messageIds)
    }

    @Test
    fun aChannelDeletionNeverRemovesADirectMessage() {
        val vm = directChat(message(id = 10, from = alice, to = ME))

        realtime.emit(WsEvent.MessageDeleted(messageId = 10, conversationType = "channel", targetId = ME))

        assertEquals(listOf(10L), vm.messageIds)
    }

    @Test
    fun onlyAVisibleChatMarksMessagesReadAndRegistersAsOpen() {
        val vm = directChat()
        realtime.sent.clear()

        realtime.emit(WsEvent.NewMessage(message(id = 20, from = alice, to = ME)))
        assertEquals("A chat in the back stack must not mark messages read", emptyList<String>(), realtime.sent)
        assertNull(registry.active.value)

        vm.onVisibilityChanged(visible = true)
        assertEquals(ConversationRef(ConversationType.DIRECT, alice), registry.active.value)
        assertEquals(listOf("mark_read direct $alice"), realtime.sent)

        realtime.emit(WsEvent.NewMessage(message(id = 21, from = alice, to = ME)))
        assertEquals(2, realtime.sent.count { it == "mark_read direct $alice" })

        vm.onVisibilityChanged(visible = false)
        assertNull(registry.active.value)
        assertEquals(listOf(20L, 21L), vm.messageIds)
    }
}
