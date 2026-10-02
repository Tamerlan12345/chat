package com.openmychat.mobile

import android.Manifest
import android.os.Build
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
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

    /** The server is fixed at build time: the first screen is login, with no way to pick a server. */
    @Test
    fun firstLaunchGoesStraightToLoginWithoutAnyServerSetup() {
        composeRule.onNode(hasText("Войти") and hasClickAction()).assertIsDisplayed().assertIsNotEnabled()

        composeRule.onAllNodes(hasText("сервер", substring = true, ignoreCase = true)).assertCountEquals(0)
        composeRule.onAllNodes(hasText("Подключ", substring = true, ignoreCase = true)).assertCountEquals(0)
    }
}
