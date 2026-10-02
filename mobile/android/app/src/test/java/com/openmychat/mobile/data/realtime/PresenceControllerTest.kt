package com.openmychat.mobile.data.realtime

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.testing.FakeRealtimeRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Присутствие как на настольном клиенте: приложение на экране — «в сети», свёрнуто — «отошёл».
 * Вручную выбирается только «Не беспокоить», и оно не меняет присутствие под собой.
 * Обычный (не мгновенный) тестовый диспетчер: порядок как в приложении.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PresenceControllerTest {

    private val realtime = FakeRealtimeRepository()
    private val me = User(id = 1, username = "me", fullName = "Я")

    private fun TestScope.controller() = PresenceController(realtime, backgroundScope).also { runCurrent() }

    private val presenceSent get() = realtime.sent.filter { it.startsWith("presence") }

    @Test
    fun foregroundIsOnlineAndBackgroundIsAway() = runTest {
        val presence = controller()
        presence.onForeground()
        presence.onBackground()
        presence.onForeground()
        assertEquals(listOf("presence online", "presence away", "presence online"), presenceSent)
        assertEquals(Presence.ONLINE, presence.presence.value)
    }

    @Test
    fun theSameStateIsNotSentTwice() = runTest {
        val presence = controller()
        presence.onForeground()
        presence.onForeground()
        presence.onBackground()
        presence.onBackground()
        assertEquals(listOf("presence online", "presence away"), presenceSent)
    }

    @Test
    fun nothingIsSentWhileDisconnectedAndTheStateIsResentOnAuthSuccess() = runTest {
        realtime.connectionState.value = ConnectionState.Disconnected
        val presence = controller()
        presence.onForeground()
        presence.onBackground()
        assertEquals(emptyList<String>(), presenceSent)

        realtime.connectionState.value = ConnectionState.Connected
        realtime.emit(WsEvent.AuthSuccess(me))
        runCurrent()
        assertEquals("после auth_success — текущее состояние", listOf("presence away"), presenceSent)
    }

    @Test
    fun aQuickReconnectThatTheStateFlowMergesStillResends() = runTest {
        val presence = controller()
        presence.onForeground()
        // Connected → Connecting → Connected без паузы: StateFlow отдаст только Connected.
        realtime.connectionState.value = ConnectionState.Connecting
        realtime.connectionState.value = ConnectionState.Connected
        realtime.emit(WsEvent.AuthSuccess(me))
        runCurrent()
        assertEquals(listOf("presence online", "presence online"), presenceSent)
    }

    @Test
    fun doNotDisturbIsSeparateAndLeavesPresenceAlone() = runTest {
        val presence = controller()
        presence.onForeground()
        presence.setDnd(true)
        presence.onBackground()
        presence.setDnd(false)
        assertEquals(listOf("presence online", "set_dnd true", "presence away", "set_dnd false"), realtime.sent)
        assertEquals(Presence.AWAY, presence.presence.value)
    }

    @Test
    fun aCustomStatusTravelsWithTheCurrentPresence() = runTest {
        val presence = controller()
        presence.onForeground()
        presence.publishCustomStatus("На встрече")
        assertEquals(listOf("presence online", "presence online custom=На встрече"), realtime.sent)
    }
}
