package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.data.realtime.ConversationRef
import com.openmychat.mobile.testing.DeliveryHarness
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
    private val chat = FakeChatRepository()
    private val delivery = DeliveryHarness(realtime, chat, mainDispatcher.dispatcher)

    private fun directChat(vararg history: com.openmychat.mobile.data.model.Message): ChatViewModel {
        chat.history = history.toList()
        return ChatViewModel(
            conversationType = ConversationType.DIRECT,
            targetId = alice,
            chatRepository = chat,
            realtimeRepository = realtime,
            sessionRepository = FakeSessionRepository(),
            activeConversations = registry,
            delivery = delivery.engine,
            sends = delivery.sends
        )
    }

    private val ChatViewModel.messageIds get() = (uiState.value as ChatUiState.Content).messages.map { it.id }

    /** Ids still shown as messages (a tombstone shows «Сообщение удалено» in its place). */
    private val ChatViewModel.liveIds get() = (uiState.value as ChatUiState.Content).messages.filter { !it.isDeleted }.map { it.id }

    @Test
    fun peerDeletingTheirMessageRemovesItEvenThoughTargetIdIsTheRecipient() {
        val vm = directChat(message(id = 10, from = alice, to = ME), message(id = 11, from = ME, to = alice))

        // The server sends target_id of the message: for alice's message that is me, not alice.
        realtime.emit(WsEvent.MessageDeleted(messageId = 10, conversationType = "direct", targetId = ME))

        assertEquals(listOf(11L), vm.liveIds)
        assertEquals("a tombstone keeps its place (delivery-state.md §3.4)", listOf(10L, 11L), vm.messageIds)
    }

    @Test
    fun deletingMyOwnMessageRemovesIt() {
        val vm = directChat(message(id = 10, from = alice, to = ME), message(id = 11, from = ME, to = alice))

        realtime.emit(WsEvent.MessageDeleted(messageId = 11, conversationType = "direct", targetId = alice))

        assertEquals(listOf(10L), vm.liveIds)
    }

    @Test
    fun aDeletionIsFoundByItsMessageIdAloneWhateverTheFrameSaysOfItsConversation() {
        // delivery-state.md §6.3 message_deleted: the message is looked up only by messageId (ids
        // are the server's, unique across conversations; targetId is the stored target_id). The
        // earlier rule — skip frames whose conversation did not match the open chat — is replaced.
        val vm = directChat(message(id = 10, from = alice, to = ME), message(id = 12, from = alice, to = ME))

        realtime.emit(WsEvent.MessageDeleted(messageId = 10, conversationType = "channel", targetId = ME))
        realtime.emit(WsEvent.MessageDeleted(messageId = 99, conversationType = "direct", targetId = alice))

        assertEquals("an unknown id deletes nothing", listOf(12L), vm.liveIds)
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
