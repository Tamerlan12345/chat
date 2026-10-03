package com.openmychat.mobile.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Same person, same colour and initials as desktop `lib/avatar.mjs` (values taken from it with node). */
class AvatarPaletteTest {

    @Test
    fun coloursAndInitialsMatchTheDesktop() {
        assertEquals(7, AvatarPalette.colorIndex("Алиса Тестова"))
        assertEquals(2, AvatarPalette.colorIndex("Боб Тестов"))
        assertEquals(7, AvatarPalette.colorIndex("Администратор системы"))
        assertEquals(0, AvatarPalette.colorIndex(""))
        assertEquals("АТ", AvatarPalette.initialsOf("Алиса Тестова"))
        assertEquals("А", AvatarPalette.initialsOf("Администратор системы"))
        assertEquals("?", AvatarPalette.initialsOf("  "))
    }

    @Test
    fun onlyHttpsImagesAreLoaded() {
        val server = "https://chat.example"
        assertEquals("https://chat.example/uploads/a.png", AvatarPalette.resolveUrl("/uploads/a.png", server))
        assertEquals("https://cdn.example/a.png", AvatarPalette.resolveUrl("https://cdn.example/a.png", server))
        assertNull(AvatarPalette.resolveUrl("http://cdn.example/a.png", server))
        assertNull(AvatarPalette.resolveUrl("file:///sdcard/a.png", server))
        assertNull(AvatarPalette.resolveUrl("  ", server))
        assertNull(AvatarPalette.resolveUrl(null, server))
    }
}
