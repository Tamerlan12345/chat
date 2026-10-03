package com.openmychat.mobile.features.auth

import com.openmychat.mobile.testing.InMemorySharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LoginTextTest {

    @Test
    fun companyNameIsPlainSingleLineTextOfBoundedLength() {
        assertEquals("АО «Сентрас Иншуранс»", CompanyName.sanitize("  АО «Сентрас Иншуранс»  "))
        // Control and bidi-override characters cannot reorder or hide text on the login screen.
        assertEquals("ООО Ромашка", CompanyName.sanitize("ООО\n\t Ромашка‮⁦\u0007"))
        assertEquals("<b>Acme</b>", CompanyName.sanitize("<b>Acme</b>")) // shown literally, never parsed
        val long = CompanyName.sanitize("Я".repeat(500))!!
        assertEquals(CompanyName.MAX_LENGTH, long.length)
        assertTrue(long.endsWith("…"))
        assertNull(CompanyName.sanitize(null))
        assertNull(CompanyName.sanitize(" ​‮ "))
    }

    @Test
    fun asciiQuotesInTheCompanyNameBecomeRussianQuotes() {
        assertEquals("АО «Ромашка»", CompanyName.sanitize("АО \"Ромашка\""))
        assertEquals("«Ромашка» ООО", CompanyName.sanitize("\"Ромашка\" ООО"))
        // The stand's real value: nested and unbalanced; the inner name is closed as well.
        assertEquals(
            "АО «Страховая компания «Сентрас Иншуранс»»",
            CompanyName.sanitize("АО \"Страховая компания \"Сентрас Иншуранс\"")
        )
        assertEquals("АО «Ромашка»", CompanyName.sanitize("АО «Ромашка»"))
        assertEquals("Ромашка", CompanyName.sanitize("Ромашка"))
    }

    @Test
    fun countdownReadsNaturally() {
        assertEquals("5 с", formatCountdown(5))
        assertEquals("59 с", formatCountdown(59))
        assertEquals("1:00", formatCountdown(60))
        assertEquals("12:05", formatCountdown(725))
    }

    @Test
    fun onlyTheLoginNameIsStoredAndOnlyInItsOwnFile() {
        val prefs = InMemorySharedPreferences()
        val store = SharedPreferencesLoginPreferences(prefs)

        store.lastUsername = "alice"

        assertEquals(mapOf("last_username" to "alice"), prefs.all)
        assertEquals("alice", SharedPreferencesLoginPreferences(prefs).lastUsername)
        store.lastUsername = "x".repeat(1_000)
        assertFalse("a pathological value is not kept", (store.lastUsername ?: "").length > 256)
    }
}
