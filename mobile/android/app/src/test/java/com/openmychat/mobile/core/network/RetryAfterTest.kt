package com.openmychat.mobile.core.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Parity minor: `Retry-After` is read in both RFC 9110 forms, and an automatic retry waits at most 30 s. */
class RetryAfterTest {

    private val now = 1_759_752_000_000L // Mon, 06 Oct 2025 12:00:00 GMT

    @Test
    fun deltaSecondsAreReadAsSent() {
        assertEquals(45L, RetryAfter.seconds("45", now))
        assertEquals(0L, RetryAfter.seconds(" 0 ", now))
    }

    @Test
    fun anHttpDateIsTheWaitUntilThatMoment() {
        assertEquals(90L, RetryAfter.seconds("Mon, 06 Oct 2025 12:01:30 GMT", now))
        assertEquals("a date in the past: no wait", 0L, RetryAfter.seconds("Mon, 06 Oct 2025 11:00:00 GMT", now))
    }

    @Test
    fun anythingElseIsIgnored() {
        assertNull(RetryAfter.seconds(null, now))
        assertNull(RetryAfter.seconds("", now))
        assertNull(RetryAfter.seconds("-5", now))
        assertNull(RetryAfter.seconds("soon", now))
    }

    @Test
    fun anAutomaticRetryWaitsAtMostThirtySeconds() {
        assertEquals(5_000L, RetryAfter.automaticWaitMs(5))
        assertEquals(30_000L, RetryAfter.automaticWaitMs(3_600))
        assertNull(RetryAfter.automaticWaitMs(null))
    }
}
