package com.openmychat.mobile.features.conversations

import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.testing.FakeAccountRepository
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** A blocked person's direct chat leaves the list (contracts/registration.md §4) and comes back on unblock. */
class ConversationsViewModelBlocksTest {

    private val dispatcher = StandardTestDispatcher()

    @get:Rule val mainDispatcher = MainDispatcherRule(dispatcher)

    private val alice = DirectConversation(userId = 7, fullName = "Алиса Тестова")
    private val bob = DirectConversation(userId = 8, fullName = "Боб Тестов")
    private val chats = FakeChatRepository(direct = listOf(alice, bob))
    private val account = FakeAccountRepository()

    private fun viewModel() = ConversationsViewModel(
        chats, FakeRealtimeRepository(), FakeSessionRepository(), ActiveConversationRegistry(), account = account
    )

    private val ConversationsViewModel.directIds
        get() = (uiState.value as ConversationsUiState.Content).directConversations.map { it.userId }

    @Test
    fun blockingRemovesTheChatAtOnceAndReloadsTheList() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        assertEquals(listOf(7L, 8L), vm.directIds)
        val loadsBefore = chats.directConversationRequests

        account.blocked.value = listOf(BlockedUser(8, "Боб Тестов"))
        runCurrent()

        assertEquals(listOf(7L), vm.directIds)
        assertEquals("the server now filters the blocked person's messages", loadsBefore + 1, chats.directConversationRequests)
    }

    @Test
    fun aBlockKnownAtStartNeverShowsTheChat() = runTest(dispatcher) {
        account.blocked.value = listOf(BlockedUser(8, "Боб Тестов"))

        val vm = viewModel()
        runCurrent()

        assertEquals(listOf(7L), vm.directIds)
    }

    @Test
    fun unblockingBringsTheChatBack() = runTest(dispatcher) {
        account.blocked.value = listOf(BlockedUser(8, "Боб Тестов"))
        val vm = viewModel()
        runCurrent()

        account.blocked.value = emptyList()
        runCurrent()

        assertEquals(listOf(7L, 8L), vm.directIds)
    }
}
