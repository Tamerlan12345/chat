package com.openmychat.mobile.core.network

import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RefreshCoordinatorTest {

    @Test
    fun concurrentRefreshCallersShareTheNewToken() = runBlocking {
        val coordinator = RefreshCoordinator()
        val storedToken = AtomicReference("expired-token")
        val refreshCalls = AtomicInteger(0)
        val tokenUpdates = AtomicInteger(0)

        val results = listOf(
            async(Dispatchers.Default) {
                coordinator.refreshIfNeeded(
                    requestToken = "expired-token",
                    currentToken = storedToken::get,
                    refresh = {
                        Thread.sleep(100)
                        refreshCalls.incrementAndGet()
                        "fresh-token"
                    },
                    updateToken = { refreshedToken ->
                        storedToken.set(refreshedToken)
                        tokenUpdates.incrementAndGet()
                    }
                )
            },
            async(Dispatchers.Default) {
                coordinator.refreshIfNeeded(
                    requestToken = "expired-token",
                    currentToken = storedToken::get,
                    refresh = {
                        refreshCalls.incrementAndGet()
                        "fresh-token"
                    },
                    updateToken = { refreshedToken ->
                        storedToken.set(refreshedToken)
                        tokenUpdates.incrementAndGet()
                    }
                )
            }
        ).awaitAll()

        assertEquals(listOf("fresh-token", "fresh-token"), results)
        assertEquals(1, refreshCalls.get())
        assertEquals(1, tokenUpdates.get())
    }

    @Test
    fun failedRefreshKeepsTheExistingSessionToken() {
        val coordinator = RefreshCoordinator()
        val storedToken = AtomicReference("still-valid-token")

        val result = coordinator.refreshIfNeeded(
            requestToken = "still-valid-token",
            currentToken = storedToken::get,
            refresh = { null },
            updateToken = storedToken::set
        )

        assertNull(result)
        assertEquals("still-valid-token", storedToken.get())
    }
}
