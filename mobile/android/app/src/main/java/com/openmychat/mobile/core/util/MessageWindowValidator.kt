package com.openmychat.mobile.core.util

/**
 * Validates message editing and deleting windows based on server configuration.
 * Adheres strictly to Section 4.1 of parity-matrix.md.
 */
object MessageWindowValidator {

    /**
     * Algorithm from mobile/contracts/parity-matrix.md:
     * - windowMinutes == -1 -> false (feature disabled on server)
     * - windowMinutes == 0  -> true  (unlimited time)
     * - isSuperAdmin && isDelete -> true (super admin can delete anytime)
     * - otherwise ageMs <= windowMinutes * 60 * 1000
     */
    fun canEditOrDelete(
        createdAtIso: String?,
        windowMinutesStr: String?,
        isSuperAdmin: Boolean = false,
        isDelete: Boolean = false,
        currentTimeMs: Long = System.currentTimeMillis()
    ): Boolean {
        if (isSuperAdmin && isDelete) return true

        val windowMinutes = windowMinutesStr?.toIntOrNull() ?: 60
        if (windowMinutes == -1) return false
        if (windowMinutes == 0) return true

        val createdMs = DateTimeUtils.parseIso8601ToMillis(createdAtIso)
        if (createdMs <= 0L) return false

        val ageMs = currentTimeMs - createdMs
        if (ageMs < 0) return true // Clock drift allowance

        return ageMs <= windowMinutes * 60 * 1000L
    }
}
