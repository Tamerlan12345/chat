package com.openmychat.mobile.features.people

import android.net.Uri

/**
 * Ссылки «набрать номер» и «написать письмо» из строк сервера. Строка проверяется и
 * кодируется (`Uri.fromParts`), а не склеивается: `mailto:` из сырой строки мог бы нести
 * лишние параметры (`?subject=…&body=…`), `tel:` — что угодно кроме номера.
 */
object ContactLinks {
    private val EMAIL = Regex("^[^\\s@?&#/:]+@[^\\s@?&#/:]+\\.[^\\s@?&#/:]+$")

    /** Номер для набора: только цифры и «+» в начале; меньше трёх цифр — не номер. */
    fun phoneNumber(raw: String): String? {
        val trimmed = raw.trim()
        val digits = trimmed.filter { it in '0'..'9' }
        if (digits.length < 3 || digits.length > 20) return null
        if (trimmed.any { !(it in '0'..'9' || it.isWhitespace() || it in "+-().") }) return null
        return if (trimmed.startsWith("+")) "+$digits" else digits
    }

    fun email(raw: String): String? = raw.trim().takeIf { it.length <= 254 && EMAIL.matches(it) }

    fun dial(raw: String): Uri? = phoneNumber(raw)?.let { Uri.fromParts("tel", it, null) }

    fun mail(raw: String): Uri? = email(raw)?.let { Uri.fromParts("mailto", it, null) }
}
