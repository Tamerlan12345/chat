package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.SendState
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.testing.DeliveryHarness
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import com.openmychat.mobile.testing.message
import com.openmychat.mobile.ui.components.DeliveryMark
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

/** QA D2: a message sent without a network stays on screen, is re-sent by itself and can be retried or dropped. */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelSendQueueTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val alice = 7L
    private val realtime = FakeRealtimeRepository()
    private val chat = FakeChatRepository()

    /** The process-wide delivery core every chat of this "process" shares. */
    private val delivery = DeliveryHarness(realtime, chat, mainDispatcher.dispatcher)

    private fun directChat() = ChatViewModel(
        conversationType = ConversationType.DIRECT,
        targetId = alice,
        chatRepository = chat,
        realtimeRepository = realtime,
        sessionRepository = FakeSessionRepository(),
        activeConversations = ActiveConversationRegistry(),
        delivery = delivery.engine,
        sends = delivery.sends
    )

    private val ChatViewModel.shown get() = (uiState.value as ChatUiState.Content).messages

    private fun echo(local: Message, id: Long) = WsEvent.NewMessage(
        message(id = id, from = ME, to = alice, text = local.text).copy(clientMsgId = local.clientMsgId)
    )

    private fun elapse(ms: Long) {
        mainDispatcher.dispatcher.scheduler.advanceTimeBy(ms)
        mainDispatcher.dispatcher.scheduler.runCurrent()
    }

    @Test
    fun aMessageSentOfflineShowsAsQueuedAndIsNotLost() {
        realtime.connectionState.value = ConnectionState.Connecting
        val vm = directChat()

        vm.sendMessage("привет")

        val bubble = vm.shown.single()
        assertEquals("привет", bubble.text)
        assertEquals(ME, bubble.senderId)
        assertEquals(SendState.QUEUED, bubble.sendState)
        assertNotNull(bubble.clientMsgId)
        assertEquals(DeliveryMark.QUEUED, sendStateMark(bubble))
        assertEquals("nothing goes to a closed socket", emptyList<String>(), realtime.sent.filter { it.startsWith("send_message") })
    }

    @Test
    fun aQueuedMessageIsSentOnceWithTheSameKeyWhenTheConnectionIsBack() {
        realtime.connectionState.value = ConnectionState.Connecting
        val vm = directChat()
        vm.sendMessage("привет")
        val queued = vm.shown.single()

        realtime.connectionState.value = ConnectionState.Connected

        assertEquals(listOf("send_message direct $alice привет"), realtime.sent.filter { it.startsWith("send_message") })
        assertEquals(listOf(queued.clientMsgId), realtime.sentClientMsgIds)
        assertEquals(SendState.SENDING, vm.shown.single().sendState)

        // The server's echo replaces the local record: still one bubble, now confirmed.
        realtime.emit(echo(queued, id = 50))
        realtime.emit(echo(queued, id = 50))
        val confirmed = vm.shown.single()
        assertEquals(50L, confirmed.id)
        assertEquals(SendState.SENT, confirmed.sendState)
        assertNull(sendStateMark(confirmed))
        assertEquals("no duplicate send after the echo", 1, realtime.sentClientMsgIds.size)
    }

    @Test
    fun aMessageSentOnlineShowsAtOnceAndTheEchoDoesNotDuplicateIt() {
        val vm = directChat()

        vm.sendMessage("сразу")

        val local = vm.shown.single()
        assertEquals(SendState.SENDING, local.sendState)
        assertEquals(listOf(local.clientMsgId), realtime.sentClientMsgIds)

        realtime.emit(echo(local, id = 60))

        assertEquals(listOf(60L), vm.shown.map { it.id })
    }

    @Test
    fun aRefusedSocketWriteKeepsTheMessageQueuedForTheNextConnection() {
        val vm = directChat()
        realtime.accepting = false

        vm.sendMessage("ушло в никуда")
        assertEquals(SendState.QUEUED, vm.shown.single().sendState)

        realtime.accepting = true
        realtime.connectionState.value = ConnectionState.Connecting
        realtime.connectionState.value = ConnectionState.Connected

        assertEquals(1, realtime.sentClientMsgIds.size)
        assertEquals(SendState.SENDING, vm.shown.single().sendState)
    }

    @Test
    fun aDropBeforeTheEchoQueuesTheMessageAgainAndTheResendKeepsTheKey() {
        val vm = directChat()
        vm.sendMessage("обрыв")
        val key = vm.shown.single().clientMsgId

        realtime.connectionState.value = ConnectionState.Connecting
        assertEquals(SendState.QUEUED, vm.shown.single().sendState)
        realtime.connectionState.value = ConnectionState.Connected

        assertEquals(listOf(key, key), realtime.sentClientMsgIds)
        assertEquals(1, vm.shown.size)
    }

    @Test
    fun aServerRejectionMarksTheMessageFailedAndRetryResendsItWithTheSameKey() {
        val vm = directChat()
        vm.sendMessage("отказ")
        val local = vm.shown.single()

        realtime.emit(WsEvent.GenericError(context = "send_message", message = "нельзя", originalText = "отказ", clientMsgId = local.clientMsgId))

        val failed = vm.shown.single()
        assertEquals(SendState.FAILED, failed.sendState)
        assertEquals(DeliveryMark.FAILED, sendStateMark(failed))

        vm.retrySend(failed)

        assertEquals(listOf(local.clientMsgId, local.clientMsgId), realtime.sentClientMsgIds)
        assertEquals(SendState.SENDING, vm.shown.single().sendState)

        realtime.emit(echo(local, id = 70))
        assertEquals(listOf(70L), vm.shown.map { it.id })
    }

    @Test
    fun noEchoWithinTheAckTimeoutMarksTheMessageFailed() {
        // delivery-state.md §7.3: an unanswered attempt is a failure; the same key goes again after
        // backoff (1, 2, 4, 8 s) and only the fifth unanswered attempt is «не отправлено».
        val vm = directChat()
        vm.sendMessage("тишина")
        val key = vm.shown.single().clientMsgId!!

        elapse(9_000)
        assertEquals(SendState.SENDING, vm.shown.single().sendState)
        elapse(1_500)
        assertEquals("timed out: waits 1 s, then goes again", SendState.QUEUED, vm.shown.single().sendState)
        elapse(54_000)
        assertEquals("the fifth attempt is out", SendState.SENDING, vm.shown.single().sendState)
        elapse(1_000)

        assertEquals(SendState.FAILED, vm.shown.single().sendState)
        assertEquals("five attempts, one key", List(5) { key }, realtime.sentClientMsgIds)
    }

    @Test
    fun anEchoCancelsTheAckTimeout() {
        val vm = directChat()
        vm.sendMessage("вовремя")
        realtime.emit(echo(vm.shown.single(), id = 80))

        elapse(30_000)

        assertEquals(SendState.SENT, vm.shown.single().sendState)
    }

    @Test
    fun discardingAFailedMessageRemovesItAndRevokesTheKeyTheServerMayHold() {
        val vm = directChat()
        vm.sendMessage("не нужно")
        val local = vm.shown.single()
        elapse(66_000) // five unanswered attempts (§7.3)
        assertEquals(SendState.FAILED, vm.shown.single().sendState)

        vm.discardFailed(vm.shown.single())

        assertEquals(emptyList<Message>(), vm.shown)
        assertEquals(listOf("cancel_message ${local.clientMsgId}"), realtime.sent.filter { it.startsWith("cancel_message") })
    }

    @Test
    fun discardingAMessageThatNeverLeftTheDeviceSendsNoRevoke() {
        realtime.connectionState.value = ConnectionState.Connecting
        val vm = directChat()
        vm.sendMessage("не ушло")
        vm.shown.single().let { assertEquals(SendState.QUEUED, it.sendState) }

        // A queued message has no failed state; the user retries a failed one only, so fail it by rejection.
        realtime.connectionState.value = ConnectionState.Connected
        val key = vm.shown.single().clientMsgId
        realtime.emit(WsEvent.GenericError("send_message", "нет", "не ушло", key))
        realtime.sent.clear()
        // Rejected by the server: it never stored it, so there is nothing to revoke either.
        vm.discardFailed(vm.shown.single())

        assertEquals(emptyList<Message>(), vm.shown)
        assertEquals(emptyList<String>(), realtime.sent.filter { it.startsWith("cancel_message") })
    }

    @Test
    fun aHistoryRefreshKeepsUnconfirmedMessagesAndDropsOnesTheServerNowHas() {
        realtime.connectionState.value = ConnectionState.Connecting
        val vm = directChat()
        vm.sendMessage("жду")
        val queued = vm.shown.single()
        chat.history = listOf(message(id = 5, from = alice, to = ME))

        vm.loadMessages()

        assertEquals(listOf(5L, queued.id), vm.shown.map { it.id })
        assertEquals(SendState.QUEUED, vm.shown.last().sendState)

        // The server already stored it (the echo was missed): history carries it with the same key.
        chat.history = listOf(message(id = 5, from = alice, to = ME), message(id = 6, from = ME, to = alice, text = "жду").copy(clientMsgId = queued.clientMsgId))
        vm.loadMessages()

        assertEquals(listOf(5L, 6L), vm.shown.map { it.id })
    }

    @Test
    fun aReopenedChatKeepsItsUnconfirmedMessagesAndResendsThem() {
        realtime.connectionState.value = ConnectionState.Connecting
        val first = directChat()
        first.sendMessage("останется")
        val key = first.shown.single().clientMsgId
        first.viewModelScope.cancel() // the screen is closed: its view model no longer works

        // The chat is opened again (new view model) once the connection is back.
        realtime.connectionState.value = ConnectionState.Connected
        val second = directChat()

        assertEquals(listOf(key), second.shown.map { it.clientMsgId })
        assertEquals(listOf(key), realtime.sentClientMsgIds)
        assertEquals(SendState.SENDING, second.shown.single().sendState)
    }

    @Test
    fun anOwnLocalBubbleCannotBeEditedOrDeleted() {
        realtime.connectionState.value = ConnectionState.Connecting
        val vm = directChat()
        vm.sendMessage("локально")

        val local = vm.shown.single()
        assertEquals(false, vm.canEditMessage(local))
        assertEquals(false, vm.canDeleteMessage(local))
    }
}
