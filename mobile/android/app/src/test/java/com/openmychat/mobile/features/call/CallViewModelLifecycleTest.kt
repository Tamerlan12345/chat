package com.openmychat.mobile.features.call

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.testing.FakeCallAudio
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class CallViewModelLifecycleTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val peer = 7L
    private val realtime = FakeRealtimeRepository()
    private val audio = FakeCallAudio()
    private val store = ViewModelStore()

    /** Creates the ViewModel through a store so clearing the store runs onCleared like a popped entry. */
    private fun call(isIncoming: Boolean, store: ViewModelStore = this.store): CallViewModel =
        ViewModelProvider(store, object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                CallViewModel(peer, "Alice", isIncoming, realtime, audio) as T
        })[CallViewModel::class.java]

    @Test
    fun poppingAnActiveCallEndsItForThePeer() {
        call(isIncoming = false)
        realtime.emit(WsEvent.CallAnswer(targetUserId = ME, senderId = peer, senderName = "Alice"))

        store.clear()

        assertEquals(listOf("call_offer $peer", "call_end $peer"), realtime.sent)
        assertTrue(audio.stopped > 0)
    }

    @Test
    fun poppingAnUnansweredOutgoingCallCancelsIt() {
        call(isIncoming = false)

        store.clear()

        assertEquals(listOf("call_offer $peer", "call_end $peer"), realtime.sent)
    }

    @Test
    fun poppingARingingIncomingCallRejectsIt() {
        call(isIncoming = true)

        store.clear()

        assertEquals(listOf("call_rejected $peer"), realtime.sent)
    }

    @Test
    fun poppingAFinishedCallSendsNothingMore() {
        call(isIncoming = false)
        realtime.emit(WsEvent.CallEnd(targetUserId = ME, senderId = peer, senderName = "Alice", reason = null))

        store.clear()

        assertEquals(listOf("call_offer $peer"), realtime.sent)
    }

    @Test
    fun leavingTheCallScreenEndsTheCallOnce() {
        val vm = call(isIncoming = false)
        realtime.emit(WsEvent.CallAnswer(targetUserId = ME, senderId = peer, senderName = "Alice"))

        vm.leave()
        vm.leave()
        store.clear()

        assertTrue(vm.uiState.value is CallUiState.Ended)
        assertEquals(1, realtime.sent.count { it == "call_end $peer" })
    }

    @Test
    fun incomingVoiceComesFromTheAudioFlow() {
        call(isIncoming = false)
        realtime.emit(WsEvent.CallAnswer(targetUserId = ME, senderId = peer, senderName = "Alice"))

        realtime.emitAudio(WsEvent.AudioFrameReceived(senderId = peer, pcmSamples = ShortArray(512)))

        assertEquals(1, audio.played.size)
    }

    @Test
    fun clearingAnOldCallDoesNotTearDownTheNextCallsAudio() {
        call(isIncoming = false)
        realtime.emit(WsEvent.CallEnd(targetUserId = ME, senderId = peer, senderName = "Alice", reason = null))

        // Call back right away: the new entry exists before the old one finishes its exit.
        val nextStore = ViewModelStore()
        call(isIncoming = false, store = nextStore)
        realtime.emit(WsEvent.CallAnswer(targetUserId = ME, senderId = peer, senderName = "Alice"))
        val nextCallback = audio.onFrameRecorded
        val stopsBefore = audio.stopped
        val endsBefore = realtime.sent.count { it == "call_end $peer" }

        store.clear()

        assertEquals("the finished call must not hang up the new one", endsBefore, realtime.sent.count { it == "call_end $peer" })
        assertSame("the shared engine must keep feeding the new call", nextCallback, audio.onFrameRecorded)
        assertEquals("the old call must not stop the new call's audio", stopsBefore, audio.stopped)
        nextStore.clear()
    }
}
