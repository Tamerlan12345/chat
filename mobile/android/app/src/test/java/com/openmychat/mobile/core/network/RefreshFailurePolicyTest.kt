package com.openmychat.mobile.core.network

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RefreshFailurePolicyTest {

    @Test
    fun onlyExplicitlyInvalidCredentialsClearTheSession() {
        assertTrue(RefreshFailurePolicy.shouldClearSession(401, "INVALID_TOKEN"))
        assertTrue(RefreshFailurePolicy.shouldClearSession(401, "TOKEN_EXPIRED"))
        assertTrue(RefreshFailurePolicy.shouldClearSession(401, "TOKEN_REVOKED"))

        assertFalse(RefreshFailurePolicy.shouldClearSession(401, null))
        assertFalse(RefreshFailurePolicy.shouldClearSession(401, "RATE_LIMITED"))
        assertFalse(RefreshFailurePolicy.shouldClearSession(500, "INVALID_TOKEN"))
        assertFalse(RefreshFailurePolicy.shouldClearSession(0, "INVALID_TOKEN"))
    }
}
