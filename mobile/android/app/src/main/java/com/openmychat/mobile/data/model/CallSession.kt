package com.openmychat.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class CallState {
    @SerialName("idle")
    IDLE,

    @SerialName("calling")
    CALLING,

    @SerialName("ringing")
    RINGING,

    @SerialName("connecting")
    CONNECTING,

    @SerialName("active")
    ACTIVE,

    @SerialName("failed")
    FAILED,

    @SerialName("ended")
    ENDED
}

@Serializable
data class CallSession(
    val peerId: Long,
    val peerName: String,
    val peerAvatar: String? = null,
    val isIncoming: Boolean = false,
    val state: CallState = CallState.IDLE,
    val durationSeconds: Long = 0L,
    val isMuted: Boolean = false,
    val isSpeakerOn: Boolean = false,
    val endReason: String? = null
)
