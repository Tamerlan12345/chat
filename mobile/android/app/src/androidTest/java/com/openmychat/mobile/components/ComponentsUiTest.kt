package com.openmychat.mobile.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.ui.components.ConnectionBanner
import com.openmychat.mobile.ui.components.JumpToLatestPill
import com.openmychat.mobile.ui.components.SwipeToReply
import com.openmychat.mobile.ui.theme.CentyChatTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** The v2 components on their own: swipe threshold, banner states, jump pill rule. */
class ComponentsUiTest {

    @get:Rule
    val compose = createComposeRule()

    private var replies = 0

    private fun showSwipe() {
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                Box(Modifier.size(width = 320.dp, height = 120.dp)) {
                    SwipeToReply(onReply = { replies++ }) {
                        Box(Modifier.size(width = 240.dp, height = 56.dp).background(Color.LightGray).testTag("bubble"))
                    }
                }
            }
        }
    }

    @Test
    fun aShortSwipeDoesNotReply() {
        showSwipe()
        compose.onNodeWithTag("bubble").performTouchInput {
            swipe(start = centerRight.copy(x = right - 4f), end = centerRight.copy(x = right - 4f - 40.dp.toPx()), durationMillis = 300)
        }
        compose.waitForIdle()
        assertEquals(0, replies)
    }

    @Test
    fun aSwipePastTheThresholdRepliesOnce() {
        showSwipe()
        compose.onNodeWithTag("bubble").performTouchInput {
            swipe(start = centerRight.copy(x = right - 4f), end = centerRight.copy(x = right - 4f - 140.dp.toPx()), durationMillis = 400)
        }
        compose.waitForIdle()
        assertEquals(1, replies)
    }

    @Test
    fun aSwipeTowardTheEndDoesNothing() {
        showSwipe()
        compose.onNodeWithTag("bubble").performTouchInput {
            swipe(start = centerLeft.copy(x = left + 4f), end = centerLeft.copy(x = left + 4f + 140.dp.toPx()), durationMillis = 400)
        }
        compose.waitForIdle()
        assertEquals(0, replies)
    }

    @Test
    fun theBannerSaysOfflineThenReconnectingThenBackOnlineAndCollapses() {
        var state by mutableStateOf<ConnectionState>(ConnectionState.Disconnected)
        var network by mutableStateOf(false)
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ConnectionBanner(state, graceMillis = 0, networkAvailable = network)
            }
        }
        compose.onNodeWithText("Нет сети").assertIsDisplayed()

        network = true
        state = ConnectionState.Connecting
        compose.waitForIdle()
        compose.onNodeWithText("Переподключение…").assertIsDisplayed()

        compose.mainClock.autoAdvance = false
        state = ConnectionState.Connected
        compose.mainClock.advanceTimeBy(200)
        compose.onNodeWithText("Снова в сети").assertIsDisplayed()

        compose.mainClock.advanceTimeBy(1_500)
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        compose.onAllNodes(hasTestTag("connection-banner")).assertCountEquals(0)
    }

    @Test
    fun aLinkThatWasNeverDownSaysNothing() {
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ConnectionBanner(ConnectionState.Connected, graceMillis = 0, networkAvailable = true)
            }
        }
        compose.mainClock.advanceTimeBy(2_000)
        compose.onAllNodes(hasText("Снова в сети")).assertCountEquals(0)
        compose.onAllNodes(hasTestTag("connection-banner")).assertCountEquals(0)
    }

    @Test
    fun theJumpPillCountsWhatIsNewAndHidesWhenNotVisible() {
        var visible by mutableStateOf(true)
        var unseen by mutableStateOf(3)
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                JumpToLatestPill(visible = visible, unseen = unseen, onClick = {})
            }
        }
        compose.onNodeWithText("3 новых").assertIsDisplayed()
        unseen = 4
        compose.waitForIdle()
        compose.onNodeWithText("4 новых").assertIsDisplayed()
        visible = false
        compose.waitForIdle()
        compose.onAllNodes(hasTestTag("new-messages-pill")).assertCountEquals(0)
    }
}
