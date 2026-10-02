package com.openmychat.mobile.di

import android.content.Context
import com.openmychat.mobile.core.audio.AudioEngine
import com.openmychat.mobile.core.audio.CallAudio
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.realtime.SessionVerifier
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides
    @Singleton
    @ApplicationScope
    fun provideApplicationScope(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Provides
    @Singleton
    fun provideApiClient(sessionManager: SessionManager): ApiClient = ApiClient(sessionManager)

    @Provides
    @Singleton
    fun provideWebSocketClient(sessionManager: SessionManager, authContext: com.openmychat.mobile.core.network.AuthContext): WebSocketClient =
        WebSocketClient(sessionManager, authContext = authContext)

    /** A refused WebSocket token is re-checked over HTTP: refresh if possible, sign out on 401. */
    @Provides
    fun provideSessionVerifier(apiClient: ApiClient): SessionVerifier = SessionVerifier { apiClient.getMe() }

    @Provides
    @Singleton
    fun provideCallAudio(@ApplicationContext context: Context): CallAudio = AudioEngine(context)
}
