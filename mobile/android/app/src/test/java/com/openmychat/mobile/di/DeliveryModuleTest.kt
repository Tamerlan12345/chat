package com.openmychat.mobile.di

import com.openmychat.mobile.data.delivery.DeliveryRuntime
import com.openmychat.mobile.data.delivery.RealtimeDeliveryLink
import com.openmychat.mobile.data.repository.UnavailableAttachments
import com.openmychat.mobile.testing.FakeDeliveryBackend
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.InMemoryDeliveryStore
import com.openmychat.mobile.testing.InMemoryUploadStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The sign-out queue is the runtime: whoever asks for it first gets a running core. Without that a
 * process where nothing else started the core (an instrumented test's application, a screen opened
 * before the engine) waits forever in `discardForSignOut` — sign-out never finished.
 */
class DeliveryModuleTest {

    @Test
    fun theSignOutQueueIsHandedOutRunning() {
        val dispatcher = StandardTestDispatcher()
        val scope = CoroutineScope(SupervisorJob() + dispatcher)
        val session = FakeSessionRepository()
        val realtime = FakeRealtimeRepository()
        val uploads = InMemoryUploadStore()
        val runtime = DeliveryRuntime.create(
            scope, InMemoryDeliveryStore(uploads), uploads, RealtimeDeliveryLink(realtime, session), FakeDeliveryBackend(),
            UnavailableAttachments, session, realtime, { }, { dispatcher.scheduler.currentTime }
        )
        try {
            val queue = DeliveryModule.outgoing(runtime)

            val discard = scope.async { queue.discardForSignOut() }
            repeat(50) { dispatcher.scheduler.advanceUntilIdle() }
            assertTrue("sign-out deleted the queue and returned", discard.isCompleted)
        } finally {
            scope.cancel()
        }
    }
}
