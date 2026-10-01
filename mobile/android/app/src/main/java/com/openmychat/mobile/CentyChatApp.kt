package com.openmychat.mobile

import android.app.Application
import com.openmychat.mobile.core.audio.AudioEngine
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.session.SessionManager

class CentyChatApp : Application() {

    lateinit var sessionManager: SessionManager
        private set

    lateinit var apiClient: ApiClient
        private set

    lateinit var webSocketClient: WebSocketClient
        private set

    lateinit var audioEngine: AudioEngine
        private set

    override fun onCreate() {
        super.onCreate()
        sessionManager = SessionManager(this)
        apiClient = ApiClient(sessionManager)
        webSocketClient = WebSocketClient(sessionManager)
        audioEngine = AudioEngine(this)
    }
}
