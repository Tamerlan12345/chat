package com.openmychat.mobile.features.call

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.audio.CallAudio
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.CallSession
import com.openmychat.mobile.data.model.CallState
import com.openmychat.mobile.data.repository.RealtimeRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedFactory
import dagger.assisted.AssistedInject
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** What the call screen shows; derived from the call session state machine. */
sealed interface CallUiState {
    val peerName: String
    val isMuted: Boolean
    val isSpeakerOn: Boolean

    data class Incoming(
        override val peerName: String,
        override val isMuted: Boolean = false,
        override val isSpeakerOn: Boolean = false
    ) : CallUiState

    data class Outgoing(
        override val peerName: String,
        override val isMuted: Boolean = false,
        override val isSpeakerOn: Boolean = false
    ) : CallUiState

    data class Active(
        override val peerName: String,
        val durationSeconds: Long,
        override val isMuted: Boolean = false,
        override val isSpeakerOn: Boolean = false
    ) : CallUiState

    data class Ended(
        override val peerName: String,
        val reason: String,
        override val isMuted: Boolean = false,
        override val isSpeakerOn: Boolean = false
    ) : CallUiState

    companion object {
        fun from(session: CallSession): CallUiState = when (session.state) {
            CallState.RINGING -> Incoming(session.peerName, session.isMuted, session.isSpeakerOn)
            CallState.IDLE, CallState.CALLING, CallState.CONNECTING ->
                Outgoing(session.peerName, session.isMuted, session.isSpeakerOn)
            CallState.ACTIVE -> Active(session.peerName, session.durationSeconds, session.isMuted, session.isSpeakerOn)
            CallState.ENDED -> Ended(session.peerName, session.endReason ?: "Вызов завершен", session.isMuted, session.isSpeakerOn)
            CallState.FAILED -> Ended(session.peerName, session.endReason ?: "Ошибка вызова", session.isMuted, session.isSpeakerOn)
        }
    }
}

@HiltViewModel(assistedFactory = CallViewModel.Factory::class)
class CallViewModel @AssistedInject constructor(
    @Assisted("peerId") val peerId: Long,
    @Assisted("peerName") val peerName: String,
    @Assisted("isIncoming") val isIncoming: Boolean,
    private val realtimeRepository: RealtimeRepository,
    private val callAudio: CallAudio
) : ViewModel() {

    @AssistedFactory
    interface Factory {
        fun create(
            @Assisted("peerId") peerId: Long,
            @Assisted("peerName") peerName: String,
            @Assisted("isIncoming") isIncoming: Boolean
        ): CallViewModel
    }

    private val _callSession = MutableStateFlow(
        CallSession(
            peerId = peerId,
            peerName = peerName,
            isIncoming = isIncoming,
            state = if (isIncoming) CallState.RINGING else CallState.CALLING
        )
    )
    val callSession: StateFlow<CallSession> = _callSession

    val uiState: StateFlow<CallUiState> = _callSession
        .map(CallUiState::from)
        .stateIn(viewModelScope, SharingStarted.Eagerly, CallUiState.from(_callSession.value))

    private var durationJob: Job? = null

    init {
        observeEvents()
        if (!isIncoming) {
            realtimeRepository.sendCallOffer(peerId)
        }

        callAudio.onFrameRecorded = { samples ->
            if (_callSession.value.state == CallState.ACTIVE) {
                realtimeRepository.sendAudioFrame(peerId, samples)
            }
        }
    }

    private fun observeEvents() {
        viewModelScope.launch {
            realtimeRepository.events.collect { event ->
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
                    is WsEvent.CallDenied -> endCall(event.reason)
                    else -> Unit
                }
            }
        }
        viewModelScope.launch {
            realtimeRepository.audioFrames.collect { frame ->
                if (frame.senderId == peerId && _callSession.value.state == CallState.ACTIVE) {
                    callAudio.onIncomingAudioFrame(frame.pcmSamples)
                }
            }
        }
    }

    private val isFinished: Boolean
        get() = _callSession.value.state == CallState.ENDED || _callSession.value.state == CallState.FAILED

    /**
     * The user leaves the call screen (system back): a ringing call is declined, anything else is
     * hung up, so the peer is never left in a call nobody sees.
     */
    fun leave() {
        when {
            isFinished -> Unit
            _callSession.value.state == CallState.RINGING -> rejectCall()
            else -> hangUp()
        }
    }

    fun acceptCall() {
        realtimeRepository.sendCallAnswer(peerId)
        startActiveCall()
    }

    fun rejectCall(reason: String = "Отклонен пользователем") {
        realtimeRepository.sendCallRejected(peerId, reason)
        endCall(reason)
    }

    fun hangUp() {
        realtimeRepository.sendCallEnd(peerId, "Завершен пользователем")
        endCall("Завершен")
    }

    private fun startActiveCall() {
        _callSession.value = _callSession.value.copy(state = CallState.ACTIVE)
        callAudio.start(viewModelScope)

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
        callAudio.stop()
        _callSession.value = _callSession.value.copy(
            state = CallState.ENDED,
            endReason = reason
        )
    }

    fun toggleMute() {
        val newMute = !_callSession.value.isMuted
        callAudio.setMute(newMute)
        _callSession.value = _callSession.value.copy(isMuted = newMute)
    }

    fun toggleSpeaker() {
        val newSpeaker = !_callSession.value.isSpeakerOn
        callAudio.setSpeakerphone(newSpeaker)
        _callSession.value = _callSession.value.copy(isSpeakerOn = newSpeaker)
    }

    override fun onCleared() {
        // The entry was popped (back, logout, stack reset) while the call was still running.
        if (!isFinished) {
            if (_callSession.value.state == CallState.RINGING) {
                realtimeRepository.sendCallRejected(peerId, "Отклонен пользователем")
            } else {
                realtimeRepository.sendCallEnd(peerId, "Завершен пользователем")
            }
        }
        callAudio.onFrameRecorded = null
        callAudio.stop()
        durationJob?.cancel()
        super.onCleared()
    }
}
