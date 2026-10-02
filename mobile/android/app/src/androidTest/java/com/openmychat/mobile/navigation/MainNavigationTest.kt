package com.openmychat.mobile.navigation

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.openmychat.mobile.MainActivity
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.User
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import org.junit.After
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import java.io.File
import javax.inject.Inject

/**
 * Signed-in navigation on a device. The test server endpoint is unreachable on purpose: screens show
 * their error states, while tabs, back handling and logout must still work.
 */
@HiltAndroidTest
class MainNavigationTest {

    private val hiltRule = HiltAndroidRule(this)
    private val composeRule = createEmptyComposeRule()

    @get:Rule
    val rules: TestRule = RuleChain.outerRule(hiltRule)
        .around(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                GrantPermissionRule.grant()
            }
        )
        .around(composeRule)

    @Inject lateinit var sessionManager: SessionManager

    private lateinit var scenario: ActivityScenario<MainActivity>

    @Before
    fun signInAndLaunch() {
        hiltRule.inject()
        sessionManager.saveAuthSuccess(User(id = 1, username = "alice", fullName = "Алиса Тестова"), "token")
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    @After
    fun close() {
        scenario.close()
    }

    private fun tab(label: String) = composeRule.onNode(hasText(label) and hasClickAction(), useUnmergedTree = false)

    @Test
    fun tabsBackAndLogout() {
        composeRule.onNodeWithText("Люди, каналы, сообщения").assertIsDisplayed()
        composeRule.waitForIdle()
        saveScreenshot("main-conversations")

        tab("Профиль").performClick()
        composeRule.onNodeWithText("Учётная запись").assertIsDisplayed()
        tab("Профиль").assertIsSelected()
        saveScreenshot("main-profile")

        tab("Объявления").performClick()
        composeRule.onNode(hasText("Объявления") and !hasClickAction()).assertIsDisplayed()

        // Back from a secondary tab returns to the start tab instead of leaving the app.
        Espresso.pressBack()
        composeRule.onNodeWithText("Люди, каналы, сообщения").assertIsDisplayed()
        tab("Чаты").assertIsSelected()

        tab("Профиль").performClick()
        composeRule.onNode(hasText("Выйти") and hasClickAction()).performScrollTo().performClick()
        composeRule.onNodeWithTag("confirm").performClick()

        composeRule.waitUntil(5_000) {
            composeRule.onAllNodes(hasText("Войти") and hasClickAction()).fetchSemanticsNodes().isNotEmpty()
        }
        assertNull(sessionManager.token)
        saveScreenshot("after-logout")
    }

    /** Каждая вкладка хранит своё состояние: строка поиска «Сотрудников» переживает уход на «Чаты». */
    @Test
    fun eachTabKeepsItsStateAcrossTabSwitches() {
        tab("Сотрудники").performClick()
        composeRule.onNodeWithTag("people-search").performTextInput("бухгалтер")
        composeRule.waitForIdle()

        tab("Чаты").performClick()
        composeRule.onNodeWithText("Люди, каналы, сообщения").assertIsDisplayed()
        tab("Сотрудники").assertIsNotSelected()

        tab("Сотрудники").performClick()
        tab("Сотрудники").assertIsSelected()
        composeRule.onNodeWithText("бухгалтер").assertIsDisplayed()

        // Клавиатуру закрываем явно: иначе первое «Назад» уходит ей, и итог зависит от IME.
        Espresso.closeSoftKeyboard()
        // «Назад» снимает поиск, следующее с корня вкладки — на «Чаты», а не из приложения.
        Espresso.pressBack()
        Espresso.pressBack()
        tab("Чаты").assertIsSelected()
    }

    private fun saveScreenshot(name: String) {
        val bitmap = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dir = File(context.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
