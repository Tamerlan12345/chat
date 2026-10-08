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
    private val realtime = FakeRealtimeRepository()
    private val delivery = DeliveryHarness(realtime, repository, mainDispatcher.dispatcher)

    private fun open(focus: Long?, saved: androidx.lifecycle.SavedStateHandle = androidx.lifecycle.SavedStateHandle()) = ChatViewModel(
        conversationType = ConversationType.DIRECT,
        targetId = bob,
        chatRepository = repository,
        realtimeRepository = realtime,
        sessionRepository = FakeSessionRepository(),
        activeConversations = ActiveConversationRegistry(),
        delivery = delivery.engine,
        sends = delivery.sends,
        saved = saved,
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
    fun afterProcessDeathTheJumpIsNotReplayed() {
        repository.around = (40L..100L).map { message(it, from = bob, to = ME) }
        val saved = androidx.lifecycle.SavedStateHandle()
        open(focus = 50, saved = saved)

        val restored = open(focus = 50, saved = saved)
        assertNull("без повторной прокрутки и вспышки", restored.focus.value)
        assertEquals("окно вокруг сообщения то же", (40L..100L).toList(), restored.ids())
    }

    @Test
    fun withoutAFocusNothingChanges() {
        val vm = open(focus = null)
        assertEquals(emptyList<Long>(), repository.aroundRequests)
        assertEquals((90L..100L).toList(), vm.ids())
        assertNull(vm.focus.value)
    }
}
