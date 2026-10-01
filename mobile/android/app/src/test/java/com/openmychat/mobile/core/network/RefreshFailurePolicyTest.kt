package com.openmychat.mobile.core.network

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RefreshFailurePolicyTest {

    @Test
    fun authenticatedRefreshRejectionsClearSessionWithoutDependingOnBodyCode() {
        assertTrue(RefreshFailurePolicy.shouldClearSession(401))
        assertTrue(RefreshFailurePolicy.shouldClearSession(403))

        assertFalse(RefreshFailurePolicy.shouldClearSession(500))
        assertFalse(RefreshFailurePolicy.shouldClearSession(0))
    }
}
