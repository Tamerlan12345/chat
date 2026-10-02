package com.openmychat.mobile

import android.Manifest
import android.os.Build
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.rule.GrantPermissionRule
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule

@HiltAndroidTest
class OnboardingTest {

    private val hiltRule = HiltAndroidRule(this)
    private val composeRule = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val rules: TestRule = RuleChain
        .outerRule(hiltRule)
        .around(notificationPermission())
        .around(composeRule)

    private fun notificationPermission(): TestRule =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            GrantPermissionRule.grant()
        }

    @Test
    fun firstLaunchAsksForTheServerAndRejectsPlainHttpToAPublicHost() {
        composeRule.onNodeWithText("Подключение к серверу").assertIsDisplayed()
        composeRule.onNodeWithText("Подключиться").assertIsNotEnabled()

        composeRule.onNode(hasSetTextAction()).performTextInput("http://chat.example.com")
        composeRule.onNodeWithText("Подключиться").assertIsEnabled().performClick()

        composeRule.waitUntil(timeoutMillis = 5_000) {
            composeRule.onAllNodesWithTextCount("Используйте HTTPS", substring = true) > 0
        }
        // Validation failed before any request: still on server setup, no navigation to login.
        composeRule.onNodeWithText("Подключение к серверу").assertIsDisplayed()
    }

    private fun androidx.compose.ui.test.junit4.AndroidComposeTestRule<*, *>.onAllNodesWithTextCount(
        text: String,
        substring: Boolean
    ): Int = onAllNodes(androidx.compose.ui.test.hasText(text, substring = substring))
        .fetchSemanticsNodes().size
}
