package com.openmychat.mobile.core.audio

import kotlinx.coroutines.CoroutineScope

/** Audio capture/playback used by a voice call; abstracted so call logic is testable on the JVM. */
interface CallAudio {
    var onFrameRecorded: ((ShortArray) -> Unit)?
    fun start(scope: CoroutineScope)
    fun stop()
    fun onIncomingAudioFrame(pcmSamples: ShortArray)
    fun setMute(muted: Boolean)
    fun setSpeakerphone(enabled: Boolean)
}
