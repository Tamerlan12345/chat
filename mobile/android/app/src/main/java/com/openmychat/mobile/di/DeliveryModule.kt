package com.openmychat.mobile.di

import android.content.Context
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.data.delivery.DeliveryEngine
import com.openmychat.mobile.data.delivery.DeliveryRuntime
import com.openmychat.mobile.data.delivery.HttpDeliveryBackend
import com.openmychat.mobile.data.delivery.RealtimeDeliveryLink
import com.openmychat.mobile.data.delivery.store.DeliveryDatabase
import com.openmychat.mobile.data.delivery.store.RoomDeliveryStore
import com.openmychat.mobile.data.delivery.store.RoomUploadStore
import com.openmychat.mobile.data.delivery.work.WorkManagerFlushScheduler
import com.openmychat.mobile.data.repository.AttachmentRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.features.chat.AttachmentSends
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import com.openmychat.mobile.core.network.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import javax.inject.Singleton

/** The delivery core (delivery-state.md): one engine, one file queue and one Room database per process. */
@Module
@InstallIn(SingletonComponent::class)
object DeliveryModule {
    @Provides
    @Singleton
    fun database(@ApplicationContext context: Context): DeliveryDatabase = DeliveryDatabase.open(context)

    @Provides
    @Singleton
    fun engine(
        database: DeliveryDatabase,
        realtime: RealtimeRepository,
        session: SessionRepository,
        api: ApiClient,
        @ApplicationScope scope: CoroutineScope
    ): DeliveryEngine = DeliveryEngine(
        scope = scope,
        store = RoomDeliveryStore(database.dao()),
        link = RealtimeDeliveryLink(realtime, session),
        backend = HttpDeliveryBackend(api)
    ).also { it.start() } // whoever asks first (the app, a worker, a screen test) gets a running engine

    @Provides
    @Singleton
    fun attachmentSends(
        database: DeliveryDatabase,
        attachments: AttachmentRepository,
        engine: DeliveryEngine,
        @ApplicationScope scope: CoroutineScope,
        realtime: RealtimeRepository
    ): AttachmentSends = AttachmentSends(scope, RoomUploadStore(database.dao()), attachments, engine).also { sends ->
        sends.start(realtime.connectionState.map { it == ConnectionState.Connected }.distinctUntilChanged())
    }

    @Provides
    @Singleton
    fun runtime(
        engine: DeliveryEngine,
        sends: AttachmentSends,
        session: SessionRepository,
        realtime: RealtimeRepository,
        @ApplicationScope scope: CoroutineScope,
        @ApplicationContext context: Context
    ): DeliveryRuntime = DeliveryRuntime(engine, sends, session, realtime, scope, WorkManagerFlushScheduler(context))
}
