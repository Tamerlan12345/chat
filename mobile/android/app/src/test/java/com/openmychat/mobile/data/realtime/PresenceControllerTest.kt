package com.openmychat.mobile.data.realtime

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.testing.FakeRealtimeRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Присутствие как на настольном клиенте: приложение на экране — «в сети», свёрнуто — «отошёл».
 * Вручную выбирается только «Не беспокоить», и оно не меняет присутствие под собой.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PresenceControllerTest {

    private val realtime = FakeRealtimeRepository()

    private fun kotlinx.coroutines.test.TestScope.controller() = PresenceController(realtime, backgroundScope)

    private val presenceSent get() = realtime.sent.filter { it.startsWith("presence") }

    @Test
    fun foregroundIsOnlineAndBackgroundIsAway() = runTest(UnconfinedTestDispatcher()) {
        val presence = controller()
        presence.onForeground()
        presence.onBackground()
        presence.onForeground()
        assertEquals(listOf("presence online", "presence away", "presence online"), presenceSent)
        assertEquals(Presence.ONLINE, presence.presence.value)
    }

    @Test
    fun theSameStateIsNotSentTwice() = runTest(UnconfinedTestDispatcher()) {
        val presence = controller()
        presence.onForeground()
        presence.onForeground()
        presence.onBackground()
        presence.onBackground()
        assertEquals(listOf("presence online", "presence away"), presenceSent)
    }

    @Test
    fun nothingIsSentWhileDisconnectedAndTheStateIsResentAfterReconnect() = runTest(UnconfinedTestDispatcher()) {
        realtime.connectionState.value = ConnectionState.Disconnected
        val presence = controller()
        presence.onForeground()
        presence.onBackground()
        assertEquals(emptyList<String>(), presenceSent)

        realtime.connectionState.value = ConnectionState.Connected
        assertEquals("после auth_success — текущее состояние", listOf("presence away"), presenceSent)

        realtime.connectionState.value = ConnectionState.Connecting
        realtime.connectionState.value = ConnectionState.Connected
        assertEquals("новый сокет — состояние снова", listOf("presence away", "presence away"), presenceSent)
    }

    @Test
    fun doNotDisturbIsSeparateAndLeavesPresenceAlone() = runTest(UnconfinedTestDispatcher()) {
        val presence = controller()
        presence.onForeground()
        presence.setDnd(true)
        presence.onBackground()
        presence.setDnd(false)
        assertEquals(listOf("presence online", "set_dnd true", "presence away", "set_dnd false"), realtime.sent)
        assertEquals(Presence.AWAY, presence.presence.value)
    }

    @Test
    fun aCustomStatusTravelsWithTheCurrentPresence() = runTest(UnconfinedTestDispatcher()) {
        val presence = controller()
        presence.onForeground()
        presence.publishCustomStatus("На встрече")
        assertEquals(listOf("presence online", "presence online custom=На встрече"), realtime.sent)
    }
}
