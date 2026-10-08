package com.openmychat.mobile.features.auth

import com.openmychat.mobile.testing.InMemorySharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class LoginTextTest {

    @Test
    fun asciiQuotesInACompanyNameBecomeRussianQuotes() {
        // The profile's «Компания» line still uses it.
        assertEquals("АО «Ромашка»", typographicQuotes("АО \"Ромашка\""))
        assertEquals("«Ромашка» ООО", typographicQuotes("\"Ромашка\" ООО"))
        // The stand's real value: nested and unbalanced; the inner name is closed as well.
        assertEquals(
            "АО «Страховая компания «Сентрас Иншуранс»»",
            typographicQuotes("АО \"Страховая компания \"Сентрас Иншуранс\"")
        )
        assertEquals("АО «Ромашка»", typographicQuotes("АО «Ромашка»"))
        assertEquals("Ромашка", typographicQuotes("Ромашка"))
    }

    @Test
    fun countdownReadsNaturally() {
        assertEquals("5 с", formatCountdown(5))
        assertEquals("59 с", formatCountdown(59))
        // copy-ru.md {wait}: never a clock-like «12:05», which screen readers mangle.
        assertEquals("1 мин", formatCountdown(60))
        assertEquals("12 мин 5 с", formatCountdown(725))
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
