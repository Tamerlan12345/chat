package com.openmychat.mobile

import android.Manifest
import android.os.Build
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.rule.GrantPermissionRule
import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.ChangePasswordResponse
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.repository.AuthRepository
import com.openmychat.mobile.data.repository.LoginResult
import com.openmychat.mobile.di.AuthModule
import dagger.hilt.android.testing.BindValue
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.UninstallModules
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import java.util.concurrent.CopyOnWriteArrayList
import javax.inject.Inject

/** The branded login screen on a device, with scripted server answers. */
@HiltAndroidTest
@UninstallModules(AuthModule::class)
class LoginScreenTest {

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

    @BindValue
    @JvmField
    val auth: AuthRepository = ScriptedAuthRepository()
    private val scripted get() = auth as ScriptedAuthRepository

    @Inject lateinit var sessionManager: SessionManager

    private var scenario: ActivityScenario<MainActivity>? = null

    @Before
    fun inject() {
        hiltRule.inject()
    }

    @After
    fun close() {
        scenario?.close()
    }

    private fun launch() {
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    private val submit get() = composeRule.onNode(hasText("Войти") and hasClickAction())
    private fun field(label: String) = composeRule.onNode(hasSetTextAction() and hasText(label))

    private fun signIn(username: String = "alice", password: String = "Secret-1") {
        field("Логин").performTextInput(username)
        field("Пароль").performTextInput(password)
        submit.assertIsEnabled().performClick()
    }

    private fun waitForText(text: String, substring: Boolean = false) = composeRule.waitUntil(5_000) {
        composeRule.onAllNodes(hasText(text, substring = substring)).fetchSemanticsNodes().isNotEmpty()
    }

    @Test
    fun theLockupAndCompanyNameAppearOnceWithoutADuplicateTitle() {
        scripted.companyName = "АО «Тестовая компания»"
        launch()

        waitForText("АО «Тестовая компания»")
        composeRule.onAllNodes(hasText("CentyChat")).assertCountEquals(1)
        composeRule.onAllNodes(hasText("Вход в CentyChat")).assertCountEquals(0)
        composeRule.onAllNodes(hasText("Корпоративный мессенджер")).assertCountEquals(0)
        submit.assertIsDisplayed().assertIsNotEnabled()
    }

    @Test
    fun withoutACompanyNameTheDefaultSubtitleIsShown() {
        scripted.companyName = null
        launch()

        waitForText("Корпоративный мессенджер")
    }

    @Test
    fun wrongCredentialsShowOneGenericMessage() {
        scripted.onLogin = { _, _ -> throw ApiException(400, null, "Пользователь alice не найден") }
        launch()

        signIn()

        waitForText("Неверный логин или пароль")
        composeRule.onAllNodes(hasText("не найден", substring = true)).assertCountEquals(0)
    }

    @Test
    fun throttlingShowsACountdownAndKeepsSubmitDisabled() {
        scripted.onLogin = { _, _ -> throw ApiException(429, "ACCOUNT_THROTTLED", "x", retryAfterSeconds = 90) }
        launch()

        signIn()

        waitForText("Слишком много попыток входа. Повторите через 1:", substring = true)
        submit.assertIsNotEnabled()
        assertEquals(1, scripted.attempts.size)
    }

    @Test
    fun aBusyServerAndNoNetworkExplainThemselves() {
        scripted.onLogin = { _, _ -> throw ApiException(503, "LOGIN_BUSY", "x", retryAfterSeconds = 30) }
        launch()
        signIn()
        waitForText("Сервер сейчас занят. Повторите через", substring = true)
    }

    @Test
    fun beingOfflineIsNotReportedAsAWrongPassword() {
        scripted.onLogin = { _, _ -> throw ApiException(0, "NETWORK_ERROR", "Unable to resolve host") }
        launch()

        signIn()

        waitForText("Нет связи с сервером. Проверьте подключение к интернету.")
    }

    @Test
    fun aSecondTapWhileSigningInSendsNothingAndSuccessOpensTheInbox() {
        val gate = CompletableDeferred<Unit>()
        scripted.onLogin = { _, _ ->
            gate.await()
            sessionManager.saveAuthSuccess(User(id = 2, username = "alice", fullName = "Алиса Тестова"), "token")
            LoginResult.SUCCESS
        }
        launch()

        signIn()
        waitForText("Выполняется вход…")
        composeRule.onNode(hasText("Выполняется вход…") and hasClickAction()).assertIsNotEnabled().performClick()
        assertEquals(1, scripted.attempts.size)

        gate.complete(Unit)
        composeRule.waitUntil(5_000) {
            composeRule.onAllNodes(hasText("Сообщения") and hasClickAction()).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun aForcedPasswordChangeClearsThePasswordFieldOnScreen() {
        scripted.onLogin = { _, _ -> LoginResult.MUST_CHANGE_PASSWORD }
        launch()

        signIn(password = "Temp-Pass-1")
        waitForText("Обязательная смена пароля")

        // The ViewModel forgot the password; the field must not keep showing (or resubmitting) it.
        composeRule.waitUntil(5_000) { renderedText(field("Пароль")).isEmpty() }
    }

    @Test
    fun thePasswordIsMaskedUntilRevealed() {
        launch()
        field("Пароль").performTextInput("Secret-1")
        assertEquals("•".repeat(8), renderedText(field("Пароль")))

        composeRule.onNode(hasContentDescription("Показать пароль")).performClick()

        assertEquals("Secret-1", renderedText(field("Пароль")))
        composeRule.onNode(hasContentDescription("Скрыть пароль")).assertIsDisplayed()
    }

    /** The text actually laid out on screen (after the visual transformation). */
    private fun renderedText(node: SemanticsNodeInteraction): String {
        val results = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { getLayout -> getLayout(results) }
        return results.first().layoutInput.text.text
    }
}

/** Scripted sign-in: each answer is set by the test before launching the activity. */
class ScriptedAuthRepository : AuthRepository {
    override val mustChangePassword = MutableStateFlow(false)
    override val isPasswordChangeForced: Boolean get() = false
    override val hasSessionToken: Boolean get() = false

    @Volatile var companyName: String? = null
    @Volatile var onLogin: suspend (String, String) -> LoginResult = { _, _ -> LoginResult.SUCCESS }
    val attempts = CopyOnWriteArrayList<String>()

    override suspend fun knock(): Boolean = false
    override suspend fun companyName(): String? = companyName

    override suspend fun login(username: String, password: String): LoginResult {
        attempts += username
        return onLogin(username, password)
    }

    override suspend fun changePassword(oldPassword: String, newPassword: String) = ChangePasswordResponse(success = true)
    override suspend fun logout() = Unit
}
