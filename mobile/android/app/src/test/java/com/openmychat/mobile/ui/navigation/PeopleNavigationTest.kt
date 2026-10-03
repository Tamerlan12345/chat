package com.openmychat.mobile.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Четыре вкладки и переходы «Сотрудники → карточка → чат» (спецификация People surface). */
class PeopleNavigationTest {

    private fun navigator() = AppNavigator(AppNavigationState.authenticated())
    private val bobCard = NavKey.Person(userId = 8, name = "Боб")
    private val chatWithBob = NavKey.Chat(conversationType = "direct", targetId = 8, title = "Боб")

    @Test
    fun fourTabsInTheSpecifiedOrder() {
        assertEquals(
            listOf(NavKey.Conversations, NavKey.People, NavKey.Announcements, NavKey.Profile),
            TopLevelRoutes
        )
    }

    @Test
    fun writeFromTheCardPushesTheChatOntoTheCurrentTabAndBackReturnsThroughTheCard() {
        val navigator = navigator()
        navigator.navigate(NavKey.People)
        navigator.navigate(bobCard)
        navigator.navigate(chatWithBob)

        assertEquals(NavKey.People, navigator.state.topLevelRoute)
        assertEquals(listOf(NavKey.People, bobCard, chatWithBob), navigator.state.topLevelBackStacks.getValue(NavKey.People).toList())

        assertTrue(navigator.goBack())
        assertEquals(bobCard, navigator.state.currentKey)
        assertTrue(navigator.goBack())
        assertEquals(NavKey.People, navigator.state.currentKey)
    }

    @Test
    fun theCardOpenedOverAChatReturnsToThatChatOnWrite() {
        val navigator = navigator()
        navigator.navigate(chatWithBob)
        navigator.navigate(bobCard)
        assertEquals(listOf(NavKey.Conversations, chatWithBob, bobCard), navigator.state.visibleKeys)

        navigator.navigate(chatWithBob)
        assertEquals(listOf(NavKey.Conversations, chatWithBob), navigator.state.visibleKeys)
    }

    @Test
    fun theSameCardIsNotStackedTwice() {
        val navigator = navigator()
        navigator.navigate(NavKey.People)
        navigator.navigate(bobCard)
        navigator.navigate(bobCard.copy(status = "online"))
        assertEquals(listOf(NavKey.People, bobCard), navigator.state.topLevelBackStacks.getValue(NavKey.People).toList())
    }

    @Test
    fun jumpingToAMessageReopensTheSameChatAtThatMessage() {
        val navigator = navigator()
        navigator.navigate(chatWithBob)
        val jump = chatWithBob.copy(focusMessageId = 42)
        navigator.navigate(jump)
        assertEquals(listOf(NavKey.Conversations, jump), navigator.state.visibleKeys)
    }

    @Test
    fun openingPeopleFromElsewhereShowsItsRoot() {
        val navigator = navigator()
        navigator.navigate(NavKey.People)
        navigator.navigate(bobCard)
        navigator.navigate(NavKey.Conversations)

        navigator.openPeople()

        assertEquals(NavKey.People, navigator.state.topLevelRoute)
        assertEquals(listOf(NavKey.People), navigator.state.topLevelBackStacks.getValue(NavKey.People).toList())
    }

    @Test
    fun tabSwitchesAreToldApartFromPushesAndPops() {
        val navigator = navigator()
        navigator.navigate(NavKey.People)
        assertTrue(navigator.lastChangeWasTabSwitch)

        navigator.navigate(bobCard)
        assertFalse(navigator.lastChangeWasTabSwitch)

        navigator.goBack()
        assertFalse("back from the card is a pop within the tab", navigator.lastChangeWasTabSwitch)

        navigator.goBack()
        assertTrue("back from a tab root returns to Chats: a tab switch", navigator.lastChangeWasTabSwitch)

        navigator.navigate(chatWithBob)
        assertFalse(navigator.lastChangeWasTabSwitch)
    }

    @Test
    fun eachTabKeepsItsStackWhileAnotherIsShown() {
        val navigator = navigator()
        navigator.navigate(NavKey.People)
        navigator.navigate(bobCard)
        navigator.navigate(NavKey.Profile)
        navigator.navigate(NavKey.People)
        assertEquals(bobCard, navigator.state.currentKey)
    }
}
