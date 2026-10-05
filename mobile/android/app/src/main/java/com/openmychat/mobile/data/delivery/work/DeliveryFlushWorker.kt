package com.openmychat.mobile.data.delivery.work

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.openmychat.mobile.data.delivery.BackgroundFlushScheduler
import com.openmychat.mobile.data.delivery.DeliveryRuntime
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import java.util.concurrent.TimeUnit

/**
 * The background flush (delivery-state.md `background_flush`): when the app has no socket — it is
 * in the background or was killed — and something waits in the outbox, the OS runs this once there
 * is a network. It goes through the same process-wide engine as the foreground socket, so an entry
 * is never sent by both.
 */
class DeliveryFlushWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Dependencies {
        fun deliveryRuntime(): DeliveryRuntime
    }

    override suspend fun doWork(): Result =
        EntryPointAccessors.fromApplication(applicationContext, Dependencies::class.java).deliveryRuntime().flushInBackground()

    companion object {
        const val NAME = "delivery-flush"
    }
}

/** One pending flush at a time, only with a network; a run that left work behind retries with backoff. */
class WorkManagerFlushScheduler(private val context: Context) : BackgroundFlushScheduler {
    override fun schedule() {
        val request = OneTimeWorkRequestBuilder<DeliveryFlushWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        runCatching {
            WorkManager.getInstance(context).enqueueUniqueWork(DeliveryFlushWorker.NAME, ExistingWorkPolicy.KEEP, request)
        }
    }
}
