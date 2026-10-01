package com.openmychat.mobile.core.network

import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class RefreshCoordinatorProactiveTest {

    @Test
    fun proactiveRefreshAtThirtyMinuteWindowSharesReactiveRefreshResult() = runBlocking {
        val coordinator = RefreshCoordinator()
        val storedToken = AtomicReference("expiring-token")
        val refreshCalls = AtomicInteger(0)
        val tokenUpdates = AtomicInteger(0)
        val nowSeconds = 10_000L

        val results = listOf(
            async(Dispatchers.Default) {
                coordinator.refreshIfExpiring(
                    requestToken = "expiring-token",
                    expiresAtEpochSeconds = nowSeconds + 1_800,
                    nowEpochSeconds = nowSeconds,
                    currentToken = storedToken::get,
                    refresh = {
                        Thread.sleep(100)
                        refreshCalls.incrementAndGet()
                        "fresh-token"
                    },
                    updateToken = { freshToken ->
                        storedToken.set(freshToken)
                        tokenUpdates.incrementAndGet()
                    }
                )
            },
            async(Dispatchers.Default) {
                coordinator.refreshIfNeeded(
                    requestToken = "expiring-token",
                    currentToken = storedToken::get,
                    refresh = {
                        refreshCalls.incrementAndGet()
                        "fresh-token"
                    },
                    updateToken = { freshToken ->
                        storedToken.set(freshToken)
                        tokenUpdates.incrementAndGet()
                    }
                )
            }
        ).awaitAll()

        assertEquals(listOf("fresh-token", "fresh-token"), results)
        assertEquals(1, refreshCalls.get())
        assertEquals(1, tokenUpdates.get())
    }
}
