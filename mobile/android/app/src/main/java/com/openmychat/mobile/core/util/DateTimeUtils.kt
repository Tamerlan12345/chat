package com.openmychat.mobile.core.util

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

object DateTimeUtils {

    private val isoFormatWithMillis = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    private val isoFormatNoMillis = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    private val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
    private val dateFormat = SimpleDateFormat("dd.MM.yy HH:mm", Locale.getDefault())

    fun parseIso8601ToMillis(isoString: String?): Long {
        if (isoString.isNullOrBlank()) return 0L
        return try {
            synchronized(isoFormatWithMillis) {
                isoFormatWithMillis.parse(isoString)?.time
            } ?: synchronized(isoFormatNoMillis) {
                isoFormatNoMillis.parse(isoString)?.time
            } ?: 0L
        } catch (_: Exception) {
            try {
                // Try java.time Instant for API 26+
                java.time.Instant.parse(isoString).toEpochMilli()
            } catch (_: Exception) {
                0L
            }
        }
    }

    fun formatTime(isoString: String?): String {
        val millis = parseIso8601ToMillis(isoString)
        if (millis == 0L) return ""
        return timeFormat.format(Date(millis))
    }

    fun formatDateTime(isoString: String?): String {
        val millis = parseIso8601ToMillis(isoString)
        if (millis == 0L) return ""
        return dateFormat.format(Date(millis))
    }

    fun formatDuration(seconds: Long): String {
        val mins = seconds / 60
        val secs = seconds % 60
        return String.format(Locale.US, "%02d:%02d", mins, secs)
    }
}
