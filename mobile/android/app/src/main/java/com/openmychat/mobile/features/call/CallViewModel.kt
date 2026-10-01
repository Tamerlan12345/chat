package com.openmychat.mobile.features.call

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.audio.AudioEngine
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.CallSession
import com.openmychat.mobile.data.model.CallState
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class CallViewModel(
    val peerId: Long,
    val peerName: String,
    val isIncoming: Boolean,
    private val webSocketClient: WebSocketClient,
    private val audioEngine: AudioEngine
) : ViewModel() {

    private val _callSession = MutableStateFlow(
        CallSession(
            peerId = peerId,
            peerName = peerName,
            isIncoming = isIncoming,
            state = if (isIncoming) CallState.RINGING else CallState.CALLING
        )
    )
    val callSession: StateFlow<CallSession> = _callSession.asStateFlow()

    private var durationJob: Job? = null

    init {
        observeEvents()
        if (!isIncoming) {
            // Outgoing call: send call_offer
            webSocketClient.sendCallOffer(peerId)
        }

        // Configure audio engine frame forwarding
        audioEngine.onFrameRecorded = { samples ->
            if (_callSession.value.state == CallState.ACTIVE) {
                webSocketClient.sendAudioFrame(peerId, samples)
            }
        }
    }

    private fun observeEvents() {
        viewModelScope.launch {
            webSocketClient.events.collect { event ->
                when (event) {
                    is WsEvent.CallAnswer -> {
                        if (event.senderId == peerId || event.targetUserId == peerId) {
                            startActiveCall()
                        }
                    }
                    is WsEvent.CallRejected -> {
                        if (event.senderId == peerId) {
                            endCall(event.reason ?: "Вызов отклонен")
                        }
                    }
                    is WsEvent.CallEnd -> {
                        if (event.senderId == peerId || event.targetUserId == peerId) {
                            endCall(event.reason ?: "Разговор завершен")
                        }
                    }
                    is WsEvent.CallUnavailable -> {
                        if (event.targetUserId == peerId) {
                            endCall(event.reason)
                        }
                    }
                    is WsEvent.CallDenied -> {
                        endCall(event.reason)
                    }
                    is WsEvent.AudioFrameReceived -> {
                        if (event.senderId == peerId && _callSession.value.state == CallState.ACTIVE) {
                            audioEngine.onIncomingAudioFrame(event.pcmSamples)
                        }
                    }
                    else -> Unit
                }
            }
        }
    }

    fun acceptCall() {
        webSocketClient.sendCallAnswer(peerId)
        startActiveCall()
    }

    fun rejectCall(reason: String = "Отклонен пользователем") {
        webSocketClient.sendCallRejected(peerId, reason)
        endCall(reason)
    }

    fun hangUp() {
        webSocketClient.sendCallEnd(peerId, "Завершен пользователем")
        endCall("Завершен")
    }

    private fun startActiveCall() {
        _callSession.value = _callSession.value.copy(state = CallState.ACTIVE)
        audioEngine.start(viewModelScope)

        durationJob?.cancel()
        durationJob = viewModelScope.launch {
            while (_callSession.value.state == CallState.ACTIVE) {
                delay(1000)
                _callSession.value = _callSession.value.copy(
                    durationSeconds = _callSession.value.durationSeconds + 1
                )
            }
        }
    }

    private fun endCall(reason: String) {
        durationJob?.cancel()
        durationJob = null
        audioEngine.stop()
        _callSession.value = _callSession.value.copy(
            state = CallState.ENDED,
            endReason = reason
        )
    }

    fun toggleMute() {
        val newMute = !_callSession.value.isMuted
        audioEngine.setMute(newMute)
        _callSession.value = _callSession.value.copy(isMuted = newMute)
    }

    fun toggleSpeaker() {
        val newSpeaker = !_callSession.value.isSpeakerOn
        audioEngine.setSpeakerphone(newSpeaker)
        _callSession.value = _callSession.value.copy(isSpeakerOn = newSpeaker)
    }

    override fun onCleared() {
        super.onCleared()
        audioEngine.stop()
        durationJob?.cancel()
    }
}
