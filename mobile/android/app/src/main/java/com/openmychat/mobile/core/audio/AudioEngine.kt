package com.openmychat.mobile.core.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import kotlinx.coroutines.*
import java.util.concurrent.atomic.AtomicBoolean

class AudioEngine(private val context: Context) : CallAudio {

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null

    private val isRecording = AtomicBoolean(false)
    private val isPlaying = AtomicBoolean(false)

    val isMuted = AtomicBoolean(false)
    val isSpeakerOn = AtomicBoolean(false)

    private val jitterBuffer = JitterBuffer()
    private var recordJob: Job? = null
    private var playbackJob: Job? = null

    override var onFrameRecorded: ((ShortArray) -> Unit)? = null

    override fun start(scope: CoroutineScope) {
        startRecording(scope)
        startPlayback(scope)
    }

    private fun startRecording(scope: CoroutineScope) {
        if (isRecording.getAndSet(true)) return

        val minBufSize = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )

        try {
            val record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBufSize.coerceAtLeast(FRAME_SIZE * 2 * 4)
            )

            if (record.state != AudioRecord.STATE_INITIALIZED) {
                isRecording.set(false)
                return
            }

            audioRecord = record
            record.startRecording()

            recordJob = scope.launch(Dispatchers.IO) {
                val buffer = ShortArray(FRAME_SIZE)
                while (isActive && isRecording.get()) {
                    val read = record.read(buffer, 0, FRAME_SIZE)
                    if (read == FRAME_SIZE) {
                        if (!isMuted.get()) {
                            val frameCopy = buffer.clone()
                            if (!SilenceGater.isSilence(frameCopy)) {
                                onFrameRecorded?.invoke(frameCopy)
                            }
                        }
                    }
                }
            }
        } catch (_: SecurityException) {
            isRecording.set(false)
        } catch (_: Exception) {
            isRecording.set(false)
        }
    }

    private fun startPlayback(scope: CoroutineScope) {
        if (isPlaying.getAndSet(true)) return

        val minBufSize = AudioTrack.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )

        try {
            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(minBufSize.coerceAtLeast(FRAME_SIZE * 2 * 4))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

            if (track.state != AudioTrack.STATE_INITIALIZED) {
                isPlaying.set(false)
                return
            }

            audioTrack = track
            track.play()

            playbackJob = scope.launch(Dispatchers.IO) {
                while (isActive && isPlaying.get()) {
                    val frame = jitterBuffer.poll()
                    if (frame != null) {
                        track.write(frame, 0, frame.size)
                    } else {
                        delay(5)
                    }
                }
            }
        } catch (_: Exception) {
            isPlaying.set(false)
        }
    }

    override fun onIncomingAudioFrame(pcmSamples: ShortArray) {
        jitterBuffer.enqueue(pcmSamples)
    }

    override fun setMute(muted: Boolean) {
        isMuted.set(muted)
    }

    override fun setSpeakerphone(enabled: Boolean) {
        isSpeakerOn.set(enabled)
        try {
            audioManager?.isSpeakerphoneOn = enabled
            audioManager?.mode = if (enabled) AudioManager.MODE_IN_COMMUNICATION else AudioManager.MODE_IN_COMMUNICATION
        } catch (_: Exception) {}
    }

    override fun stop() {
        isRecording.set(false)
        isPlaying.set(false)

        recordJob?.cancel()
        recordJob = null

        playbackJob?.cancel()
        playbackJob = null

        try {
            audioRecord?.stop()
            audioRecord?.release()
        } catch (_: Exception) {}
        audioRecord = null

        try {
            audioTrack?.stop()
            audioTrack?.release()
        } catch (_: Exception) {}
        audioTrack = null

        jitterBuffer.clear()
        try {
            audioManager?.mode = AudioManager.MODE_NORMAL
            audioManager?.isSpeakerphoneOn = false
        } catch (_: Exception) {}
    }

    companion object {
        const val SAMPLE_RATE = 16000
        const val FRAME_SIZE = 512
    }
}
