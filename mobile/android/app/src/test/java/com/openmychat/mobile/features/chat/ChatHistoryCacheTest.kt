package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.testing.DeliveryHarness
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import com.openmychat.mobile.testing.message
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Reopening a chat shows what was there at once (no skeleton flash) and refreshes underneath. The
 * in-memory history cache is gone: the delivery model's conversation cache (in memory for the
 * process, in Room across restarts) is what a reopened chat shows.
 */
class ChatHistoryCacheTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val bob = 3L
    private val repository = FakeChatRepository(history = listOf(message(id = 10, from = bob, to = ME)))
    private val session = FakeSessionRepository()
    private val realtime = FakeRealtimeRepository()
    private val delivery = DeliveryHarness(realtime, repository, mainDispatcher.dispatcher, session = session)

    private fun open(userId: Long = ME) = ChatViewModel(
        conversationType = ConversationType.DIRECT,
        targetId = bob,
        chatRepository = repository,
        realtimeRepository = realtime,
        sessionRepository = if (userId == ME) session else FakeSessionRepository(userId),
        activeConversations = ActiveConversationRegistry(),
        delivery = delivery.engine,
        sends = delivery.sends
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

    @Test
    fun signingOutClearsTheCache() {
        open()
        assertEquals(listOf(10L), delivery.engine.state.value.messages["direct:$bob"]?.map { it.id })
        assertTrue("the cache reached the store", delivery.store.stored.cache.isNotEmpty() || delivery.engine.state.value.messages.isNotEmpty())

        session.token.value = null

        assertNull(delivery.engine.state.value.messages["direct:$bob"])
        assertTrue("nothing of the session stays on disk", delivery.store.stored.cache.isEmpty())
        assertTrue(delivery.store.stored.outbox.isEmpty())
    }

    @Test
    fun aFailedRefreshOverCachedHistoryKeepsItAndSaysSo() {
        open()
        repository.historyFailure = IllegalStateException("offline")

        val reopened = open()

        assertEquals(listOf(10L), reopened.ids())
        assertEquals(true, reopened.refreshFailed.value)
    }
}
