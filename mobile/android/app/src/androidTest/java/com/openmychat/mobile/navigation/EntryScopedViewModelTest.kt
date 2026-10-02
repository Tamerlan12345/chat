package com.openmychat.mobile.navigation

import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.ui.NavDisplay
import com.openmychat.mobile.ui.navigation.AppNavigationState
import com.openmychat.mobile.ui.navigation.AppNavigator
import com.openmychat.mobile.ui.navigation.NavKey
import com.openmychat.mobile.ui.navigation.toDecoratedEntries
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule

/**
 * Exercises the real NavDisplay + decorator wiring of the app: ViewModels must belong to their
 * back stack entry, survive tab switches, and be cleared when the entry is popped or on logout.
 */
@HiltAndroidTest
class EntryScopedViewModelTest {

    private val hiltRule = HiltAndroidRule(this)
    private val composeRule = createComposeRule()

    @get:Rule
    val rules: TestRule = RuleChain.outerRule(hiltRule).around(composeRule)

    class ProbeViewModel : ViewModel() {
        var cleared = false
            private set

        override fun onCleared() {
            cleared = true
        }
    }

    private val created = mutableMapOf<String, MutableList<ProbeViewModel>>()
    private val navigator = AppNavigator(AppNavigationState.authenticated())

    private fun latest(name: String) = created.getValue(name).last()

    @Before
    fun showNavigation() {
        composeRule.setContent {
            val entries = navigator.state.toDecoratedEntries(
                entryProvider {
                    entry<NavKey.Login> { Probe("login") }
                    entry<NavKey.Conversations> { Probe("conversations") }
                    entry<NavKey.Announcements> { Probe("announcements") }
                    entry<NavKey.Profile> { Probe("profile") }
                    entry<NavKey.Call> { key -> Probe("call", key.callId) }
                }
            )
            NavDisplay(entries = entries, onBack = { navigator.goBack() })
        }
    }

    @androidx.compose.runtime.Composable
    private fun Probe(name: String, label: String = name) {
        val vm = viewModel { ProbeViewModel() }
        val list = created.getOrPut(name) { mutableListOf() }
        if (list.none { it === vm }) list += vm
        Text("screen $name $label")
    }

    @Test
    fun aRepeatedCallToTheSamePeerGetsAFreshViewModel() {
        val first = NavKey.Call(peerId = 7, peerName = "Alice")
        composeRule.runOnIdle { navigator.navigate(first) }
        composeRule.onNodeWithText("screen call ${first.callId}").assertExists()
        val firstVm = latest("call")

        composeRule.runOnIdle { navigator.closeCall(first) }
        composeRule.waitUntil(5_000) { firstVm.cleared }

        val second = NavKey.Call(peerId = 7, peerName = "Alice")
        composeRule.runOnIdle { navigator.navigate(second) }
        composeRule.onNodeWithText("screen call ${second.callId}").assertExists()

        assertNotSame(firstVm, latest("call"))
        assertFalse(latest("call").cleared)
    }

    @Test
    fun backFromACallClearsItsViewModel() {
        composeRule.runOnIdle { navigator.navigate(NavKey.Call(peerId = 7, peerName = "Alice")) }
        composeRule.waitForIdle()
        val callVm = latest("call")

        composeRule.runOnIdle { assertTrue(navigator.goBack()) }

        composeRule.waitUntil(5_000) { callVm.cleared }
    }

    @Test
    fun switchingTabsKeepsEachTabsViewModel() {
        composeRule.onNodeWithText("screen conversations conversations").assertExists()
        val conversations = latest("conversations")

        composeRule.runOnIdle { navigator.navigate(NavKey.Profile) }
        composeRule.onNodeWithText("screen profile profile").assertExists()
        composeRule.runOnIdle { navigator.navigate(NavKey.Conversations) }
        composeRule.waitForIdle()

        assertSame(conversations, latest("conversations"))
        assertFalse(conversations.cleared)
        assertEquals(1, created.getValue("conversations").size)
    }

    @Test
    fun logoutClearsEveryProtectedViewModel() {
        composeRule.runOnIdle { navigator.navigate(NavKey.Profile) }
        composeRule.onNodeWithText("screen profile profile").assertExists()
        val conversations = latest("conversations")
        val profile = latest("profile")

        composeRule.runOnIdle { navigator.onLoggedOut() }
        composeRule.onNodeWithText("screen login login").assertExists()

        composeRule.waitUntil(5_000) { conversations.cleared && profile.cleared }
    }
}
