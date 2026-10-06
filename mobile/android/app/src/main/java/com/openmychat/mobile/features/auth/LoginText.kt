package com.openmychat.mobile.features.auth

import java.util.Locale

/**
 * `АО "Ромашка"` → `АО «Ромашка»`. A quote at the start or after a space or bracket opens, any other
 * closes; quotes left open at the end are closed, so `АО "Компания "Имя"` reads `АО «Компания «Имя»»`.
 */
fun typographicQuotes(text: String): String {
    if ('"' !in text) return text
    var depth = 0
    val out = StringBuilder(text.length + 2)
    text.forEachIndexed { index, char ->
        if (char != '"') {
            out.append(char)
            return@forEachIndexed
        }
        val previous = text.getOrNull(index - 1)
        val opens = previous == null || previous.isWhitespace() || previous in "([{«" || depth == 0
        if (opens) {
            depth++
            out.append('«')
        } else {
            depth--
            out.append('»')
        }
    }
    repeat(depth) { out.append('»') }
    return out.toString()
}

/** "45 с" under a minute, "12:05" from a minute up (the server may ask for up to an hour). */
fun formatCountdown(seconds: Long): String =
    if (seconds < 60) "$seconds с" else String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60)
