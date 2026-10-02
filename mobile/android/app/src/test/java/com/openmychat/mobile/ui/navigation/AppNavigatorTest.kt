package com.openmychat.mobile.ui.navigation

import com.openmychat.mobile.core.session.SessionStorageState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppNavigatorTest {

    private val chatWithAlice = NavKey.Chat(conversationType = "direct", targetId = 7, title = "Alice")
    private val chatWithBob = NavKey.Chat(conversationType = "direct", targetId = 8, title = "Bob")

    private fun authenticatedNavigator() = AppNavigator(AppNavigationState.authenticated())

    @Test
    fun switchingTabsNeverStacksDuplicateTopLevelEntries() {
        val navigator = authenticatedNavigator()

        navigator.navigate(NavKey.Announcements)
        navigator.navigate(NavKey.Profile)
        navigator.navigate(NavKey.Conversations)
        navigator.navigate(NavKey.Announcements)
        navigator.navigate(NavKey.Announcements)

        assertEquals(NavKey.Announcements, navigator.state.topLevelRoute)
        assertEquals(listOf(NavKey.Conversations, NavKey.Announcements), navigator.state.visibleKeys)
        navigator.state.topLevelBackStacks.forEach { (root, stack) -> assertEquals(listOf(root), stack.toList()) }
    }

    @Test
    fun eachTabKeepsItsOwnBackStack() {
        val navigator = authenticatedNavigator()
        navigator.navigate(chatWithAlice)

        navigator.navigate(NavKey.Profile)
        assertEquals(listOf(NavKey.Conversations, chatWithAlice, NavKey.Profile), navigator.state.visibleKeys)

        navigator.navigate(NavKey.Conversations)
        assertEquals(chatWithAlice, navigator.state.currentKey)
    }

    @Test
    fun reselectingTheCurrentTabPopsToItsRoot() {
        val navigator = authenticatedNavigator()
        navigator.navigate(chatWithAlice)

        navigator.navigate(NavKey.Conversations)

        assertEquals(listOf(NavKey.Conversations), navigator.state.visibleKeys)
    }

    @Test
    fun backPopsWithinTabThenReturnsToStartTabThenExits() {
        val navigator = authenticatedNavigator()
        navigator.navigate(NavKey.Announcements)

        assertTrue(navigator.goBack())
        assertEquals(NavKey.Conversations, navigator.state.topLevelRoute)
        assertEquals(listOf(NavKey.Conversations), navigator.state.visibleKeys)

        navigator.navigate(chatWithAlice)
        assertTrue(navigator.goBack())
        assertEquals(listOf(NavKey.Conversations), navigator.state.visibleKeys)

        assertFalse("Back on the start destination leaves the app", navigator.goBack())
    }

    @Test
    fun openingAnotherChatReplacesTheShownChatAndTheSameChatIsNotDuplicated() {
        val navigator = authenticatedNavigator()

        navigator.navigate(chatWithAlice)
        navigator.navigate(chatWithAlice.copy(status = "away"))
        navigator.navigate(chatWithBob)

        assertEquals(listOf(NavKey.Conversations, chatWithBob), navigator.state.visibleKeys)
    }

    @Test
    fun logoutClearsEveryStackToLogin() {
        val navigator = authenticatedNavigator()
        navigator.navigate(chatWithAlice)
        navigator.navigate(NavKey.Call(peerId = 7, peerName = "Alice"))
        navigator.navigate(NavKey.Profile)

        navigator.onLoggedOut(hasConfiguredServer = true)

        assertTrue(navigator.state.isAuthFlow)
        assertEquals(listOf(NavKey.Login), navigator.state.visibleKeys)
        assertEquals(NavKey.Conversations, navigator.state.topLevelRoute)
        assertFalse("Back from Login after logout must not reveal protected screens", navigator.goBack())
        // Even the tab roots are dropped so their ViewModels never leak into the next session.
        navigator.state.topLevelBackStacks.values.forEach { stack -> assertTrue(stack.isEmpty()) }
        assertFalse(navigator.hasActiveCall)

        navigator.navigate(NavKey.Conversations)
        navigator.state.topLevelBackStacks.forEach { (root, stack) -> assertEquals(listOf(root), stack.toList()) }
    }

    @Test
    fun logoutWithoutConfiguredServerReturnsToServerSetup() {
        val navigator = authenticatedNavigator()

        navigator.onLoggedOut(hasConfiguredServer = false)

        assertEquals(listOf(NavKey.ServerConnect), navigator.state.visibleKeys)
    }

    @Test
    fun signingInLeavesTheAuthFlowWithoutABackPathToLogin() {
        val navigator = AppNavigator(AppNavigationState.unauthenticated(hasConfiguredServer = false))
        navigator.navigate(NavKey.Login)
        assertEquals(listOf(NavKey.ServerConnect, NavKey.Login), navigator.state.visibleKeys)

        navigator.navigate(NavKey.Conversations)

        assertFalse(navigator.state.isAuthFlow)
        assertTrue(navigator.state.authBackStack.isEmpty())
        assertEquals(listOf(NavKey.Conversations), navigator.state.visibleKeys)
        assertFalse(navigator.goBack())
    }

    @Test
    fun returningToServerSetupFromLoginPopsInsteadOfPushing() {
        val navigator = AppNavigator(AppNavigationState.unauthenticated(hasConfiguredServer = true))

        navigator.navigate(NavKey.ServerConnect)
        navigator.navigate(NavKey.Login)

        assertEquals(listOf(NavKey.Login), navigator.state.visibleKeys)
    }

    @Test
    fun incomingCallIsShownOnceAndRejectedWhileAnotherCallIsOpen() {
        val navigator = authenticatedNavigator()

        assertTrue(navigator.showIncomingCall(NavKey.Call(peerId = 7, peerName = "Alice", isIncoming = true)))
        assertFalse(navigator.showIncomingCall(NavKey.Call(peerId = 8, peerName = "Bob", isIncoming = true)))

        assertEquals(1, navigator.state.visibleKeys.count { it is NavKey.Call })
        assertTrue(navigator.hasActiveCall)
    }

    @Test
    fun repeatedCallsToTheSamePeerGetDistinctEntries() {
        val first = NavKey.Call(peerId = 7, peerName = "Alice")
        val second = NavKey.Call(peerId = 7, peerName = "Alice")

        assertNotEquals("Each call needs its own NavEntry and therefore its own ViewModel", first, second)
    }

    @Test
    fun restoredProtectedStackIsDroppedWhenTheSessionIsGone() {
        val navigator = authenticatedNavigator()
        navigator.navigate(chatWithAlice)
        val lostSession = AuthenticatedRouteState("token", hasCurrentUser = true, SessionStorageState.UNAVAILABLE)

        navigator.syncWithSession(lostSession, hasConfiguredServer = true)

        assertEquals(listOf(NavKey.Login), navigator.state.visibleKeys)
    }

    @Test
    fun restoredAuthStackIsDroppedWhenTheSessionIsValid() {
        val navigator = AppNavigator(AppNavigationState.unauthenticated(hasConfiguredServer = true))
        val validSession = AuthenticatedRouteState("token", hasCurrentUser = true, SessionStorageState.AVAILABLE)

        navigator.syncWithSession(validSession, hasConfiguredServer = true)

        assertEquals(listOf(NavKey.Conversations), navigator.state.visibleKeys)
    }

    @Test
    fun protectedDestinationsCannotBePushedIntoTheAuthFlow() {
        val navigator = AppNavigator(AppNavigationState.unauthenticated(hasConfiguredServer = true))

        navigator.navigate(chatWithAlice)

        assertEquals(listOf(NavKey.Login), navigator.state.visibleKeys)
    }
}
