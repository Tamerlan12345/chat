package com.openmychat.mobile.features.auth

import java.util.Locale

/**
 * `company_name` comes from an unauthenticated endpoint, so it is untrusted input shown on the
 * screen where people type their password. It is rendered as plain Compose text (never parsed as
 * HTML or a link), reduced to one line without control or bidi-override characters (which could
 * reorder or hide text), and capped in length.
 */
object CompanyName {
    const val MAX_LENGTH = 80

    fun sanitize(raw: String?): String? {
        if (raw == null) return null
        val visible = buildString {
            raw.forEach { char ->
                when {
                    char.isWhitespace() || Character.isISOControl(char) -> append(' ')
                    Character.getType(char) == Character.FORMAT.toInt() -> Unit // bidi controls, zero-width
                    else -> append(char)
                }
            }
        }
        val singleLine = visible.trim().replace(Regex("""\s+"""), " ")
        if (singleLine.isEmpty()) return null
        return if (singleLine.length <= MAX_LENGTH) singleLine else singleLine.take(MAX_LENGTH - 1).trimEnd() + "…"
    }
}

/** "45 с" under a minute, "12:05" from a minute up (the server may ask for up to an hour). */
fun formatCountdown(seconds: Long): String =
    if (seconds < 60) "$seconds с" else String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60)
