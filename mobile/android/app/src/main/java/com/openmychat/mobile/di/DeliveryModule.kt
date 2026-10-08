package com.openmychat.mobile.di

import android.content.Context
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.data.delivery.DeliveryEngine
import com.openmychat.mobile.data.delivery.DeliveryRuntime
import com.openmychat.mobile.data.delivery.HttpDeliveryBackend
import com.openmychat.mobile.data.delivery.OutgoingQueue
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
import kotlinx.coroutines.CoroutineScope
import javax.inject.Singleton

/** The delivery core (delivery-state.md): one engine, one file queue and one Room database per process. */
@Module
@InstallIn(SingletonComponent::class)
object DeliveryModule {
    @Provides
    @Singleton
    fun database(@ApplicationContext context: Context): DeliveryDatabase = DeliveryDatabase.open(context)

    /** The engine, the file queue and the runtime are wired in one place ([DeliveryRuntime.create]). */
    @Provides
    @Singleton
    fun runtime(
        database: DeliveryDatabase,
        attachments: AttachmentRepository,
        realtime: RealtimeRepository,
        session: SessionRepository,
        api: ApiClient,
        @ApplicationScope scope: CoroutineScope,
        @ApplicationContext context: Context
    ): DeliveryRuntime = DeliveryRuntime.create(
        scope = scope,
        store = RoomDeliveryStore(database.dao()),
        uploadStore = RoomUploadStore(database.dao()),
        link = RealtimeDeliveryLink(realtime, session),
        backend = HttpDeliveryBackend(api),
        files = attachments,
        session = session,
        realtime = realtime,
        scheduler = WorkManagerFlushScheduler(context),
        log = { message, error -> android.util.Log.w("Delivery", message, error) }
    )

    /** Whoever asks first (the app, a worker, a screen) gets a running core, started once by the runtime. */
    @Provides
    @Singleton
    fun engine(runtime: DeliveryRuntime): DeliveryEngine = runtime.also { it.start() }.engine

    @Provides
    @Singleton
    fun attachmentSends(runtime: DeliveryRuntime): AttachmentSends = runtime.also { it.start() }.sends

    /**
     * Sign-out asks about unsent messages and deletes them through the runtime — a running one: a
     * core nobody started would never answer `discardForSignOut`, and sign-out would never finish.
     */
    @Provides
    fun outgoing(runtime: DeliveryRuntime): OutgoingQueue = runtime.also { it.start() }
}
