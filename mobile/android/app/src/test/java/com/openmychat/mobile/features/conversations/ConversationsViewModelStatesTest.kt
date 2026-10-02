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
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Pull-to-refresh, typing previews and name search in the inbox. */
class ConversationsViewModelStatesTest {

    private val dispatcher = StandardTestDispatcher()

    @get:Rule val mainDispatcher = MainDispatcherRule(dispatcher)

    private val alice = 7L
    private val realtime = FakeRealtimeRepository()
    private val chats = FakeChatRepository(
        direct = listOf(DirectConversation(userId = alice, fullName = "Алиса Тестова", departmentName = "Бухгалтерия")),
        channels = listOf(Channel(id = 3, name = "mobile-dev"))
    )

    private fun viewModel() = ConversationsViewModel(chats, realtime, FakeSessionRepository(), ActiveConversationRegistry())

    @Test
    fun aFailedRefreshKeepsTheListAndSaysSo() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        assertTrue(vm.uiState.value is ConversationsUiState.Content)

        chats.failWith = IllegalStateException("Unable to resolve host")
        val event = backgroundScope.async { vm.events.first() }
        vm.refresh()
        assertTrue(vm.isRefreshing.value)
        runCurrent()

        assertTrue("content stays on screen", vm.uiState.value is ConversationsUiState.Content)
        assertFalse(vm.isRefreshing.value)
        assertEquals(ConversationsEvent.RefreshFailed, event.await())
    }

    @Test
    fun typingShowsInTheRowForThreeSeconds() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()

        realtime.emit(WsEvent.UserTyping(userId = alice, userName = "Алиса", conversationType = "direct", targetId = ME, isTyping = true))
        runCurrent()
        assertEquals(setOf(ConversationRef(ConversationType.DIRECT, alice)), vm.typing.value)

        advanceTimeBy(3_001)
        assertEquals(emptySet<ConversationRef>(), vm.typing.value)
    }

    @Test
    fun ownTypingInAChannelIsNotShown() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()

        realtime.emit(WsEvent.UserTyping(userId = ME, userName = "Я", conversationType = "channel", targetId = 3, isTyping = true))
        runCurrent()
        assertEquals(emptySet<ConversationRef>(), vm.typing.value)
    }

    @Test
    fun searchMatchesNamesOnly() {
        val people = chats.direct
        assertEquals(1, filterByName(people, "алиса").size)
        assertEquals(1, filterByName(people, "  Тестова ").size)
        assertEquals("the department is not a name", 0, filterByName(people, "Бухгалтерия").size)
        assertEquals(1, filterChannelsByName(chats.channels, "mobile").size)
    }
}
