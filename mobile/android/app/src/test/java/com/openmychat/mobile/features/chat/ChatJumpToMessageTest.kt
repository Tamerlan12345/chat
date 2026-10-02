package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import com.openmychat.mobile.testing.message
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Из поиска: чат открывается на найденном сообщении, а не на последних. */
class ChatJumpToMessageTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val bob = 3L
    private val repository = FakeChatRepository(history = (90L..100L).map { message(it, from = bob, to = ME) })

    private fun open(focus: Long?) = ChatViewModel(
        conversationType = ConversationType.DIRECT,
        targetId = bob,
        chatRepository = repository,
        realtimeRepository = FakeRealtimeRepository(),
        sessionRepository = FakeSessionRepository(),
        activeConversations = ActiveConversationRegistry(),
        historyCache = ChatHistoryCache(FakeSessionRepository()),
        focusMessageId = focus
    )

    private fun ChatViewModel.ids() = (uiState.value as ChatUiState.Content).messages.map { it.id }

    @Test
    fun theHistoryAroundTheFoundMessageIsShownAndItIsFocused() {
        repository.around = (20L..100L).map { message(it, from = bob, to = ME) }
        val vm = open(focus = 50)

        assertEquals(listOf(50L), repository.aroundRequests)
        assertEquals((20L..100L).toList(), vm.ids())
        assertEquals(50L, vm.focus.value)

        vm.onFocusShown()
        assertNull(vm.focus.value)
    }

    @Test
    fun aMessageTooFarBackOpensTheLatestAndSaysSo() {
        repository.around = null
        val vm = open(focus = 5)

        assertEquals((90L..100L).toList(), vm.ids())
        assertNull(vm.focus.value)
        assertTrue(vm.jumpUnavailable.value)
    }

    @Test
    fun aRefreshAfterTheJumpKeepsTheWindowWithoutJumpingAgain() {
        repository.around = (40L..100L).map { message(it, from = bob, to = ME) }
        val vm = open(focus = 50)
        vm.onFocusShown()

        vm.loadMessages()
        assertEquals(listOf(50L, 50L), repository.aroundRequests)
        assertEquals((40L..100L).toList(), vm.ids())
        assertNull(vm.focus.value)
    }

    @Test
    fun withoutAFocusNothingChanges() {
        val vm = open(focus = null)
        assertEquals(emptyList<Long>(), repository.aroundRequests)
        assertEquals((90L..100L).toList(), vm.ids())
        assertNull(vm.focus.value)
    }
}
