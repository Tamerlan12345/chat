package com.openmychat.mobile.navigation

import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldState
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldValue
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import com.openmychat.mobile.ui.navigation.rememberBottomBarState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/**
 * Task 17 minor: on chat → inbox the bar came back 250–290 ms late. The scaffold slides the bar on
 * its state's *current* value, so that value must flip in the next frame, not after a first spring.
 */
class BottomBarStateTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    fun theBarStartsBackWithinAFrameOrTwo() {
        var hidden by mutableStateOf(true)
        lateinit var state: NavigationSuiteScaffoldState
        compose.mainClock.autoAdvance = false
        compose.setContent { state = rememberBottomBarState(hidden) }
        compose.mainClock.advanceTimeByFrame()
        assertEquals(NavigationSuiteScaffoldValue.Hidden, state.currentValue)

        hidden = false
        compose.mainClock.advanceTimeBy(48) // three frames

        assertEquals(NavigationSuiteScaffoldValue.Visible, state.currentValue)

        hidden = true
        compose.mainClock.advanceTimeBy(48)
        assertEquals(NavigationSuiteScaffoldValue.Hidden, state.currentValue)
    }
}
