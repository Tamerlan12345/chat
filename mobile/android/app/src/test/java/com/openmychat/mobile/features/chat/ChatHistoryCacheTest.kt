package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import com.openmychat.mobile.testing.message
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Reopening a chat shows what was there at once (no skeleton flash) and refreshes underneath. */
class ChatHistoryCacheTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val bob = 3L
    private val repository = FakeChatRepository(history = listOf(message(id = 10, from = bob, to = ME)))
    private val cache = ChatHistoryCache()

    private fun open(userId: Long = ME) = ChatViewModel(
        conversationType = ConversationType.DIRECT,
        targetId = bob,
        chatRepository = repository,
        realtimeRepository = FakeRealtimeRepository(),
        sessionRepository = FakeSessionRepository(userId),
        activeConversations = ActiveConversationRegistry(),
        historyCache = cache
    )

    private fun ChatViewModel.ids() = (uiState.value as? ChatUiState.Content)?.messages?.map { it.id }

    @Test
    fun aReopenedChatShowsItsLastHistoryWhileItRefreshes() {
        open()
        repository.history = listOf(message(id = 10, from = bob, to = ME), message(id = 11, from = ME, to = bob))
        val gate = CompletableDeferred<Unit>()
        repository.historyGate = gate

        val reopened = open()
        assertEquals("cached history at once, not Loading", listOf(10L), reopened.ids())

        gate.complete(Unit)
        assertEquals(listOf(10L, 11L), reopened.ids())
    }

    @Test
    fun anotherSignedInUserNeverSeesTheCache() {
        open(userId = ME)
        repository.historyGate = CompletableDeferred()

        val someoneElse = open(userId = 99L)
        assertEquals(ChatUiState.Loading, someoneElse.uiState.value)
    }
}
