package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.SendState
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.testing.DeliveryHarness
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import com.openmychat.mobile.testing.message
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** QA D1: an open chat catches up with the messages that arrived while the connection was down. */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelResyncTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val alice = 7L
    private val realtime = FakeRealtimeRepository()
    private val chat = FakeChatRepository(history = listOf(message(id = 1, from = alice, to = ME)))
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

    private fun elapse(ms: Long) {
        mainDispatcher.dispatcher.scheduler.advanceTimeBy(ms)
        mainDispatcher.dispatcher.scheduler.runCurrent()
    }

    private fun drop() {
        realtime.connectionState.value = ConnectionState.Connecting
        realtime.connectionState.value = ConnectionState.Connected
    }

    @Test
    fun gapMessagesAppearAfterReconnectWithoutDuplicates() {
        val vm = directChat()
        assertEquals(listOf(1L), vm.shown.map { it.id })

        realtime.connectionState.value = ConnectionState.Connecting
        chat.history = listOf(1L, 2L, 3L).map { message(id = it, from = alice, to = ME) }
        realtime.connectionState.value = ConnectionState.Connected
        elapse(2_000)

        assertEquals(listOf(1L, 2L, 3L), vm.shown.map { it.id })
    }

    @Test
    fun anUnconfirmedLocalMessageSurvivesTheResync() {
        realtime.connectionState.value = ConnectionState.Connecting
        val vm = directChat()
        vm.sendMessage("в оффлайне")
        val key = vm.shown.last().clientMsgId

        chat.history = listOf(1L, 2L).map { message(id = it, from = alice, to = ME) }
        realtime.connectionState.value = ConnectionState.Connected
        elapse(2_000)

        assertEquals(listOf(1L, 2L), vm.shown.filter { it.sendState == SendState.SENT }.map { it.id })
        assertEquals(1, vm.shown.count { it.clientMsgId == key })
    }

    @Test
    fun aMessageTheServerAlreadyStoredIsNotDuplicatedByTheResync() {
        val vm = directChat()
        vm.sendMessage("ушло")
        val key = vm.shown.last().clientMsgId
        realtime.connectionState.value = ConnectionState.Connecting
        chat.history = listOf(
            message(id = 1, from = alice, to = ME),
            message(id = 5, from = ME, to = alice, text = "ушло").copy(clientMsgId = key)
        )
        realtime.connectionState.value = ConnectionState.Connected
        elapse(2_000)

        assertEquals(listOf(1L, 5L), vm.shown.map { it.id })
    }

    @Test
    fun aFlappingConnectionIsOneHistoryRequest() {
        var requests = 0
        val counting = object : FakeChatRepository(history = chat.history) {
            override suspend fun messages(conversationType: ConversationType, targetId: Long) =
                super.messages(conversationType, targetId).also { requests++ }
        }
        val flapped = ChatViewModel(
            ConversationType.DIRECT, alice, counting, realtime, FakeSessionRepository(), ActiveConversationRegistry(),
            delivery.engine, delivery.sends
        )
        val initial = requests

        repeat(4) {
            drop()
            elapse(100)
        }
        elapse(2_000)

        assertEquals(1, requests - initial)
        assertEquals(listOf(1L), flapped.shown.map { it.id })
    }
}

/** QA D1 follow-up: foreground entry and a link that drops inside the debounce window. */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelForegroundResyncTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val alice = 7L
    private val realtime = FakeRealtimeRepository()
    private val foreground = com.openmychat.mobile.data.realtime.ForegroundSignal()
    private var requests = 0
    private val chat = object : FakeChatRepository(history = listOf(message(id = 1, from = alice, to = ME))) {
        override suspend fun messages(conversationType: ConversationType, targetId: Long) =
            super.messages(conversationType, targetId).also { requests++ }
    }

    private val delivery = DeliveryHarness(realtime, chat, mainDispatcher.dispatcher)

    private fun directChat() = ChatViewModel(
        conversationType = ConversationType.DIRECT,
        targetId = alice,
        chatRepository = chat,
        realtimeRepository = realtime,
        sessionRepository = FakeSessionRepository(),
        activeConversations = ActiveConversationRegistry(),
        delivery = delivery.engine,
        sends = delivery.sends,
        foreground = foreground
    )

    private fun elapse(ms: Long) {
        mainDispatcher.dispatcher.scheduler.advanceTimeBy(ms)
        mainDispatcher.dispatcher.scheduler.runCurrent()
    }

    @Test
    fun foregroundWhileConnectedReloadsOnce() {
        directChat()
        val before = requests
        foreground.enter()
        elapse(2_000)
        assertEquals(1, requests - before)
    }

    @Test
    fun foregroundAndReconnectTogetherAreOneReload() {
        directChat()
        val before = requests
        realtime.connectionState.value = ConnectionState.Connecting
        realtime.connectionState.value = ConnectionState.Connected
        foreground.enter()
        elapse(2_000)
        assertEquals(1, requests - before)
    }

    @Test
    fun aLinkThatDropsInsideTheWindowDoesNotReload() {
        directChat()
        val before = requests
        realtime.connectionState.value = ConnectionState.Connecting
        realtime.connectionState.value = ConnectionState.Connected
        elapse(300)
        realtime.connectionState.value = ConnectionState.Connecting
        elapse(2_000)
        assertEquals(0, requests - before)
    }

    @Test
    fun theFirstStartDoesNotRefreshTwice() {
        directChat()
        elapse(2_000)
        assertEquals(1, requests)
    }
}
