package com.openmychat.mobile.core.network

import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** `Retry-After` (RFC 9110 §10.2.3): delta-seconds or an HTTP-date. */
object RetryAfter {
    /** The longest an automatic retry (uploads, sync) waits on the server's word; a person can always retry sooner. */
    const val AUTOMATIC_CAP_MS = 30_000L

    /** Seconds to wait from [nowMillis]; null when [value] is absent or unreadable. A past date is 0. */
    fun seconds(value: String?, nowMillis: Long): Long? {
        val text = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        text.toLongOrNull()?.let { return it.takeIf { seconds -> seconds >= 0 } }
        val at = runCatching { ZonedDateTime.parse(text, DateTimeFormatter.RFC_1123_DATE_TIME) }.getOrNull() ?: return null
        val millis = at.toInstant().toEpochMilli() - nowMillis
        return if (millis <= 0) 0 else (millis + 999) / 1_000
    }

    /** The wait of an automatic retry: the server's, but never more than [AUTOMATIC_CAP_MS]. */
    fun automaticWaitMs(seconds: Long?): Long? = seconds?.let { minOf(it * 1_000, AUTOMATIC_CAP_MS) }
}
