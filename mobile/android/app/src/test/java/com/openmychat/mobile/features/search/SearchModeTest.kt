package com.openmychat.mobile.features.search

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The field and the screen below it must agree: a query in the field always means the results. */
class SearchModeTest {

    @Test
    fun aQueryInTheFieldKeepsSearchModeEvenWithoutFocus() {
        // After Back closes the keyboard the field keeps its text, so the results must stay.
        assertTrue(SearchMode.isActive(focused = false, query = "бо"))
    }

    @Test
    fun focusAloneOpensSearchModeWithAnEmptyQuery() {
        // After "Очистить" the field is still focused: recents show, and typing needs no extra tap.
        assertTrue(SearchMode.isActive(focused = true, query = ""))
    }

    @Test
    fun noFocusAndNoQueryIsThePlainList() {
        assertFalse(SearchMode.isActive(focused = false, query = ""))
    }
}
