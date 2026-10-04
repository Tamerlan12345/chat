package com.openmychat.mobile.features.conversations

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** QA D1: after a network drop the list catches up with what arrived during the gap. */
@OptIn(ExperimentalCoroutinesApi::class)
class ConversationsViewModelResyncTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val alice = 7L
    private val realtime = FakeRealtimeRepository()
    private val chats = FakeChatRepository(direct = listOf(DirectConversation(userId = alice, fullName = "Alice", unreadCount = 0)))

    private fun viewModel() = ConversationsViewModel(chats, realtime, FakeSessionRepository(), ActiveConversationRegistry())

    private fun elapse(ms: Long) {
        mainDispatcher.dispatcher.scheduler.advanceTimeBy(ms)
        mainDispatcher.dispatcher.scheduler.runCurrent()
    }

    private fun ConversationsViewModel.unread() =
        (uiState.value as ConversationsUiState.Content).directConversations.single().unreadCount

    @Test
    fun messagesThatArrivedDuringTheGapShowAfterReconnect() {
        val vm = viewModel()
        assertEquals(0, vm.unread())

        realtime.connectionState.value = ConnectionState.Connecting
        chats.direct = listOf(DirectConversation(userId = alice, fullName = "Alice", unreadCount = 2, lastMessageText = "пропущено"))
        realtime.connectionState.value = ConnectionState.Connected
        elapse(2_000)

        assertEquals(2, vm.unread())
        assertEquals("пропущено", (vm.uiState.value as ConversationsUiState.Content).directConversations.single().lastMessageText)
    }

    @Test
    fun aFlappingConnectionIsOneRefresh() {
        val vm = viewModel()
        val before = chats.directConversationRequests

        repeat(4) {
            realtime.connectionState.value = ConnectionState.Connecting
            elapse(100)
            realtime.connectionState.value = ConnectionState.Connected
            elapse(100)
        }
        elapse(2_000)

        assertEquals(1, chats.directConversationRequests - before)
        assertEquals(0, vm.unread())
    }

    @Test
    fun theFirstConnectionDoesNotRefreshAgain() {
        realtime.connectionState.value = ConnectionState.Connected
        viewModel()
        elapse(2_000)

        assertEquals(1, chats.directConversationRequests)
    }
}

/** QA D1 follow-up: foreground entry and a link that drops inside the debounce window. */
@OptIn(ExperimentalCoroutinesApi::class)
class ConversationsViewModelForegroundResyncTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val realtime = FakeRealtimeRepository()
    private val foreground = com.openmychat.mobile.data.realtime.ForegroundSignal()
    private val chats = FakeChatRepository(direct = listOf(DirectConversation(userId = 7, fullName = "Alice")))

    private fun viewModel() = ConversationsViewModel(
        chats, realtime, FakeSessionRepository(), ActiveConversationRegistry(),
        foreground = foreground
    )

    private fun elapse(ms: Long) {
        mainDispatcher.dispatcher.scheduler.advanceTimeBy(ms)
        mainDispatcher.dispatcher.scheduler.runCurrent()
    }

    @Test
    fun foregroundWhileConnectedReloadsOnce() {
        viewModel()
        val before = chats.directConversationRequests
        foreground.enter()
        elapse(2_000)
        assertEquals(1, chats.directConversationRequests - before)
    }

    @Test
    fun foregroundAndReconnectTogetherAreOneReload() {
        viewModel()
        val before = chats.directConversationRequests
        realtime.connectionState.value = ConnectionState.Connecting
        realtime.connectionState.value = ConnectionState.Connected
        foreground.enter()
        elapse(2_000)
        assertEquals(1, chats.directConversationRequests - before)
    }

    @Test
    fun aLinkThatDropsInsideTheWindowDoesNotReload() {
        viewModel()
        val before = chats.directConversationRequests
        realtime.connectionState.value = ConnectionState.Connecting
        realtime.connectionState.value = ConnectionState.Connected
        elapse(300)
        realtime.connectionState.value = ConnectionState.Connecting
        elapse(2_000)
        assertEquals(0, chats.directConversationRequests - before)
    }

    @Test
    fun theFirstStartDoesNotRefreshTwice() {
        viewModel()
        elapse(2_000)
        assertEquals(1, chats.directConversationRequests)
    }
}
