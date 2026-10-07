package com.openmychat.mobile.features.auth


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

/**
 * A wait as copy-ru.md writes `{wait}` on every client: «45 с» under a minute, otherwise
 * «2 мин 30 с», or «10 мин» when the seconds are 0 — never a clock-like «2:30», which screen
 * readers mangle (the server may ask for up to an hour).
 */
fun formatCountdown(seconds: Long): String {
    if (seconds < 60) return "$seconds с"
    val minutes = seconds / 60
    val rest = seconds % 60
    return if (rest == 0L) "$minutes мин" else "$minutes мин $rest с"
}
