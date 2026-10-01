package com.openmychat.mobile.util

import com.openmychat.mobile.core.util.MessageWindowValidator
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageWindowValidatorTest {

    @Test
    fun testWindowDisabledReturnsFalse() {
        val createdAt = "2026-09-30T10:00:00.000Z"
        val currentTimeMs = 1759230000000L

        val canEdit = MessageWindowValidator.canEditOrDelete(
            createdAtIso = createdAt,
            windowMinutesStr = "-1",
            isSuperAdmin = false,
            isDelete = false,
            currentTimeMs = currentTimeMs
        )
        assertFalse("When windowMinutes is -1, editing must be disabled", canEdit)
    }

    @Test
    fun testWindowZeroMeansUnlimited() {
        // Message sent long ago
        val createdAt = "2020-01-01T00:00:00.000Z"
        val currentTimeMs = System.currentTimeMillis()

        val canEdit = MessageWindowValidator.canEditOrDelete(
            createdAtIso = createdAt,
            windowMinutesStr = "0",
            isSuperAdmin = false,
            isDelete = false,
            currentTimeMs = currentTimeMs
        )
        assertTrue("When windowMinutes is 0, action is unlimited", canEdit)
    }

    @Test
    fun testSuperAdminCanAlwaysDelete() {
        val createdAt = "2020-01-01T00:00:00.000Z"
        val currentTimeMs = System.currentTimeMillis()

        val canDelete = MessageWindowValidator.canEditOrDelete(
            createdAtIso = createdAt,
            windowMinutesStr = "15",
            isSuperAdmin = true,
            isDelete = true,
            currentTimeMs = currentTimeMs
        )
        assertTrue("SuperAdmin moderator should always be allowed to delete", canDelete)
    }

    @Test
    fun testWithinWindowReturnsTrue() {
        // Created 10 minutes ago, window is 30 minutes
        val currentTimeMs = 1759230600000L // arbitrary fixed time
        val tenMinutesAgoMs = currentTimeMs - (10 * 60 * 1000L)

        val createdAt = java.time.Instant.ofEpochMilli(tenMinutesAgoMs).toString()

        val canEdit = MessageWindowValidator.canEditOrDelete(
            createdAtIso = createdAt,
            windowMinutesStr = "30",
            isSuperAdmin = false,
            isDelete = false,
            currentTimeMs = currentTimeMs
        )
        assertTrue("Message created 10 minutes ago with 30-min window should be editable", canEdit)
    }

    @Test
    fun testOutsideWindowReturnsFalse() {
        // Created 45 minutes ago, window is 30 minutes
        val currentTimeMs = 1759230600000L
        val fortyFiveMinutesAgoMs = currentTimeMs - (45 * 60 * 1000L)

        val createdAt = java.time.Instant.ofEpochMilli(fortyFiveMinutesAgoMs).toString()

        val canEdit = MessageWindowValidator.canEditOrDelete(
            createdAtIso = createdAt,
            windowMinutesStr = "30",
            isSuperAdmin = false,
            isDelete = false,
            currentTimeMs = currentTimeMs
        )
        assertFalse("Message created 45 minutes ago with 30-min window should NOT be editable", canEdit)
    }
}
