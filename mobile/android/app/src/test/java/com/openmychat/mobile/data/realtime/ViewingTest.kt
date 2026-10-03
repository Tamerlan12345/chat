package com.openmychat.mobile.data.realtime

import com.openmychat.mobile.core.network.AuthContext
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.testing.FakeRealtimeRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** «Смотрю этот чат» (multi-device.md §4, чек-лист §10): когда, что и в каком порядке уходит на сервер. */
@OptIn(ExperimentalCoroutinesApi::class)
class ViewingTest {

    private val realtime = FakeRealtimeRepository()
    private val registry = ActiveConversationRegistry()
    private val authContext = AuthContext()
    private val me = User(id = 1, username = "me", fullName = "Я")
    private val chat5 = ConversationRef(ConversationType.DIRECT, 5)
    private val channel7 = ConversationRef(ConversationType.CHANNEL, 7)

    private fun TestScope.controller() =
        PresenceController(realtime, backgroundScope, registry, authContext).also { runCurrent() }

    private fun TestScope.settle() {
        advanceTimeBy(100)
        runCurrent()
    }

    @Test
    fun openingAndLeavingAChatInTheForegroundSendsViewingAfterPresence() = runTest {
        val presence = controller()
        presence.onForeground()
        registry.enter(chat5)
        settle()
        registry.leave(chat5)
        settle()
        assertEquals(listOf("presence online", "viewing direct 5", "viewing null"), realtime.sent)
    }

    @Test
    fun onlyChangesAreSent() = runTest {
        val presence = controller()
        presence.onForeground()
        registry.enter(chat5)
        settle()
        registry.enter(chat5)
        presence.onForeground()
        settle()
        assertEquals(listOf("presence online", "viewing direct 5"), realtime.sent)
    }

    @Test
    fun inTheBackgroundNoViewingIsSentAndReturningResendsIt() = runTest {
        val presence = controller()
        presence.onForeground()
        registry.enter(chat5)
        settle()
        presence.onBackground()
        settle()
        presence.onForeground()
        settle()
        assertEquals(
            "в фоне — только away (сервер снимает viewing сам); на переднем плане — заново",
            listOf("presence online", "viewing direct 5", "presence away", "presence online", "viewing direct 5"),
            realtime.sent
        )
    }

    @Test
    fun afterEveryAuthSuccessTheCurrentStateIsSentAgain() = runTest {
        val presence = controller()
        presence.onForeground()
        registry.enter(channel7)
        settle()
        realtime.sent.clear()

        realtime.connectionState.value = ConnectionState.Connecting
        runCurrent()
        realtime.connectionState.value = ConnectionState.Connected
        realtime.emit(WsEvent.AuthSuccess(me))
        settle()
        assertEquals(listOf("presence online", "viewing channel 7"), realtime.sent)
    }

    @Test
    fun framesAreThrottledAndTheLastStateWins() = runTest {
        val presence = controller()
        presence.onForeground()
        registry.enter(chat5)
        runCurrent()
        // Быстрая смена чатов в пределах паузы: уходит только итоговое состояние.
        registry.enter(channel7)
        registry.enter(ConversationRef(ConversationType.DIRECT, 9))
        runCurrent()
        assertEquals(listOf("presence online", "viewing direct 5"), realtime.sent)
        settle()
        assertEquals(listOf("presence online", "viewing direct 5", "viewing direct 9"), realtime.sent)
    }

    @Test
    fun theAuthFrameCarriesBackgroundAndTheOpenChat() = runTest {
        val presence = controller()
        presence.onForeground()
        registry.enter(chat5)
        runCurrent()
        assertFalse(authContext.snapshot().background)
        assertEquals(ConversationType.DIRECT to 5L, authContext.snapshot().viewing)

        presence.onBackground()
        runCurrent()
        assertTrue(authContext.snapshot().background)
        assertNull("в фоне viewing не передаётся", authContext.snapshot().viewing)
    }
}
