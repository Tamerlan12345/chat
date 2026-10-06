package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.testing.DeliveryHarness
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

/** Typing frames: at most one per 3 s while typing, one stop frame on a 5 s pause or on send. */
@OptIn(ExperimentalCoroutinesApi::class)
class TypingSignalTest {

    @Test
    fun keystrokesSendOneFramePerThreeSeconds() = runTest {
        val sent = mutableListOf<Boolean>()
        val signal = TypingSignal(backgroundScope) { sent += it }

        repeat(10) {
            signal.onInput(true)
            advanceTimeBy(250) // 10 keystrokes in 2.5 s
        }
        assertEquals("one frame for the first 2.5 s of typing", listOf(true), sent)

        advanceTimeBy(600) // 3.1 s since the first frame
        signal.onInput(true)
        assertEquals("a second frame once 3 s have passed", listOf(true, true), sent)
    }

    @Test
    fun aFiveSecondPauseSendsOneStopFrame() = runTest {
        val sent = mutableListOf<Boolean>()
        val signal = TypingSignal(backgroundScope) { sent += it }

        signal.onInput(true)
        advanceTimeBy(4_900)
        runCurrent()
        assertEquals(listOf(true), sent)

        advanceTimeBy(200)
        runCurrent()
        assertEquals(listOf(true, false), sent)

        advanceTimeBy(10_000)
        runCurrent()
        assertEquals("nothing more while idle", listOf(true, false), sent)
    }

    @Test
    fun sendingOrClearingTheFieldStopsAtOnceAndOnlyOnce() = runTest {
        val sent = mutableListOf<Boolean>()
        val signal = TypingSignal(backgroundScope) { sent += it }

        signal.onInput(true)
        signal.stop()
        signal.stop()
        signal.onInput(false)
        assertEquals(listOf(true, false), sent)

        // Typing again right after a send starts a new run at once.
        signal.onInput(true)
        assertEquals(listOf(true, false, true), sent)
        advanceTimeBy(6_000)
        runCurrent()
        assertEquals(listOf(true, false, true, false), sent)
    }

    @Test
    fun noStopFrameWithoutATypingFrame() = runTest {
        val sent = mutableListOf<Boolean>()
        val signal = TypingSignal(backgroundScope) { sent += it }

        signal.onInput(false)
        signal.stop()

        assertEquals(emptyList<Boolean>(), sent)
    }
}

/** The chat sends typing through the throttle and holds the peer's indicator like the desktop (6 s). */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelTypingTest {

    @get:Rule val mainDispatcher = MainDispatcherRule(StandardTestDispatcher())

    private val alice = 7L
    private val realtime = FakeRealtimeRepository()
    private val chat = FakeChatRepository()

    private fun open(): ChatViewModel {
        val delivery = DeliveryHarness(realtime, chat, mainDispatcher.dispatcher)
        return ChatViewModel(
            conversationType = ConversationType.DIRECT,
            targetId = alice,
            chatRepository = chat,
            realtimeRepository = realtime,
            sessionRepository = FakeSessionRepository(),
            activeConversations = ActiveConversationRegistry(),
            delivery = delivery.engine,
            sends = delivery.sends
        )
    }

    private val typingFrames get() = realtime.sent.filter { it.startsWith("typing") }

    @Test
    fun everyKeystrokeIsNotAFrame() {
        val vm = open()
        val scheduler = mainDispatcher.dispatcher.scheduler
        scheduler.runCurrent()

        repeat(20) {
            vm.onTyping(true)
            scheduler.advanceTimeBy(100)
        }
        vm.onTyping(false) // sent

        assertEquals(listOf("typing 7 true", "typing 7 false"), typingFrames)
    }

    @Test
    fun thePeersIndicatorHoldsBetweenFramesThreeSecondsApart() {
        val vm = open()
        val scheduler = mainDispatcher.dispatcher.scheduler
        scheduler.runCurrent()
        val typing = WsEvent.UserTyping(userId = alice, userName = "Алиса", conversationType = "direct", targetId = 1, isTyping = true)

        realtime.emit(typing)
        scheduler.runCurrent()
        scheduler.advanceTimeBy(3_100)
        scheduler.runCurrent()
        assertEquals("still typing until the next frame", "Алиса", vm.typingUser.value)

        scheduler.advanceTimeBy(3_000)
        scheduler.runCurrent()
        assertNull("no frame for 6 s: the indicator goes", vm.typingUser.value)
    }
}
