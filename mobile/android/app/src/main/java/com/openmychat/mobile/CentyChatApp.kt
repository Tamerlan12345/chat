package com.openmychat.mobile

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.data.realtime.PresenceController
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class CentyChatApp : Application(), SingletonImageLoader.Factory {

    @Inject lateinit var apiClient: ApiClient
    @Inject lateinit var presence: PresenceController
    @Inject lateinit var foregroundSignal: com.openmychat.mobile.data.realtime.ForegroundSignal

    /** Создаётся сразу: при конце сессии (выход, 401, отозванный токен) он стирает кэш справочника. */
    @Inject lateinit var people: com.openmychat.mobile.data.repository.PeopleRepository

    /** Уведомления о сообщениях из кадров сокета (notify) и снятие по conversation_read — с запуска. */
    @Inject lateinit var notifier: com.openmychat.mobile.data.notifications.MessageNotifier

    /** The delivery core: the stored outbox is restored and sent from the first moment of the process. */
    @Inject lateinit var delivery: com.openmychat.mobile.data.delivery.DeliveryRuntime

    override fun onCreate() {
        super.onCreate()
        delivery.start()
        // Присутствие как на настольном клиенте: процесс на экране — «В сети», свёрнут — «Отошёл».
        // Сигнал — жизненный цикл всего процесса: системный диалог разрешения, окно «Поделиться»
        // или экран звонка внутри приложения его не останавливают, а поворот экрана сглажен.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                presence.onForeground()
                foregroundSignal.enter()
            }
            override fun onStop(owner: LifecycleOwner) = presence.onBackground()
        })
    }

    /** Avatars load through the app's OkHttp client (TLS policy, bearer only to the fixed server). */
    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { apiClient.imageHttpClient })) }
            .build()
}
