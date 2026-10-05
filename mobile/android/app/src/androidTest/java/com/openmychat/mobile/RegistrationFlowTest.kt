package com.openmychat.mobile

import android.Manifest
import android.os.Build
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.rule.GrantPermissionRule
import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.data.model.RegisterRequestBody
import com.openmychat.mobile.data.model.RegistrationChallenge
import com.openmychat.mobile.data.model.RegistrationOutcome
import com.openmychat.mobile.data.model.ReportBody
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.repository.AccountRepository
import com.openmychat.mobile.data.repository.AuthRepository
import com.openmychat.mobile.di.AccountModule
import com.openmychat.mobile.di.AuthModule
import dagger.hilt.android.testing.BindValue
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.UninstallModules
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

/** Self-registration from the login screen to «Заявка на рассмотрении», with a scripted server. */
@HiltAndroidTest
@UninstallModules(AuthModule::class, AccountModule::class)
class RegistrationFlowTest {

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

    @BindValue
    @JvmField
    val account: AccountRepository = ScriptedAccountRepository()
    private val scripted get() = account as ScriptedAccountRepository

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

    private fun tag(tag: String) = composeRule.onNode(hasTestTag(tag))

    private fun waitForText(text: String, substring: Boolean = false) = composeRule.waitUntil(5_000) {
        composeRule.onAllNodes(hasText(text, substring = substring)).fetchSemanticsNodes().isNotEmpty()
    }

    private fun waitForTag(tag: String) = composeRule.waitUntil(5_000) {
        composeRule.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty()
    }

    private fun openRegistration() {
        launch()
        waitForTag("login-register")
        composeRule.onNode(hasText("Зарегистрироваться") and hasClickAction()).performClick()
        waitForText("Регистрация")
    }

    private fun fillForm() {
        tag("register-email").performTextInput("Ivan@Company.kz")
        tag("register-name").performTextInput("Иван Иванов")
        tag("register-username").performTextInput("ivanov")
        tag("register-password").performTextInput("Secret-12")
        tag("register-submit").performScrollTo().performClick()
    }

    @Test
    fun formCodeAndPendingScreenEndBackAtLogin() {
        openRegistration()

        fillForm()

        waitForTag("register-code-screen")
        waitForText("Мы отправили 6-значный код на ivan@company.kz.")
        assertEquals(
            RegisterRequestBody(email = "ivan@company.kz", username = "ivanov", displayName = "Иван Иванов", password = "Secret-12"),
            scripted.requests.single()
        )
        tag("register-verify").assertIsNotEnabled()
        tag("register-resend").assertIsNotEnabled()
        waitForText("Отправить код ещё раз через", substring = true)

        tag("register-code").performTextInput("123456")
        tag("register-verify").assertIsEnabled().performClick()

        waitForText("Заявка на рассмотрении")
        assertEquals(listOf("r-1:123456"), scripted.verifications)
        tag("account-status-back").performClick()
        waitForTag("login-register")
    }

    @Test
    fun anInvalidFormShowsWhatToFixAndSendsNothing() {
        openRegistration()

        tag("register-submit").performScrollTo().performClick()

        waitForText("Укажите адрес эл. почты")
        waitForText("Придумайте пароль")
        assertEquals(0, scripted.requests.size)
    }

    @Test
    fun missingMailSetupIsExplained() {
        scripted.onRequest = { throw ApiException(503, null, "Отправка почты не настроена") }
        openRegistration()

        fillForm()

        waitForText("Отправка почты не настроена", substring = true)
        tag("register-email").assertExists()
    }

    @Test
    fun aWrongCodeShowsTheAttemptsLeft() {
        scripted.onVerify = { throw ApiException(400, "CODE_INVALID", "Неверный код", attemptsLeft = 2) }
        openRegistration()
        fillForm()
        waitForTag("register-code")

        tag("register-code").performTextInput("000000")
        tag("register-verify").performClick()

        waitForText("Неверный код. Осталось попыток: 2.")
    }

    @Test
    fun anAllowedAddressSignsStraightIn() {
        scripted.onVerify = {
            sessionManager.saveAuthSuccess(User(id = 42, username = "ivanov", fullName = "Иван Иванов"), "token")
            RegistrationOutcome.SignedIn(User(id = 42, username = "ivanov", fullName = "Иван Иванов"))
        }
        openRegistration()
        fillForm()
        waitForTag("register-code")

        tag("register-code").performTextInput("123456")
        tag("register-verify").performClick()

        composeRule.waitUntil(5_000) {
            composeRule.onAllNodes(hasText("Чаты") and hasClickAction()).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun aRejectedRegistrationOnLoginOpensItsScreen() {
        (auth as ScriptedAuthRepository).onLogin = { _, _ -> throw ApiException(403, "ACCOUNT_REJECTED", "Заявка отклонена") }
        launch()
        composeRule.onNode(hasSetTextLabel("Логин")).performTextInput("ivanov")
        composeRule.onNode(hasSetTextLabel("Пароль")).performTextInput("Secret-12")
        composeRule.onNode(hasText("Войти") and hasClickAction()).performClick()

        waitForText("Заявка отклонена")
        waitForText("Обратитесь к администратору", substring = true)
        tag("account-status-back").performClick()
        waitForTag("login-register")
    }

    private fun hasSetTextLabel(label: String) =
        androidx.compose.ui.test.hasSetTextAction() and hasText(label)
}

/** Scripted registration server: each answer is set by the test before it acts. */
class ScriptedAccountRepository : AccountRepository {
    override val blocked = MutableStateFlow<List<BlockedUser>>(emptyList())

    @Volatile var onRequest: suspend (RegisterRequestBody) -> RegistrationChallenge = { RegistrationChallenge("code_sent", "r-1", 600) }
    @Volatile var onVerify: suspend () -> RegistrationOutcome = { RegistrationOutcome.Pending }
    val requests = CopyOnWriteArrayList<RegisterRequestBody>()
    val verifications = CopyOnWriteArrayList<String>()

    override suspend fun requestRegistration(body: RegisterRequestBody): RegistrationChallenge {
        requests += body
        return onRequest(body)
    }

    override suspend fun verifyRegistration(registrationId: String, code: String): RegistrationOutcome {
        verifications += "$registrationId:$code"
        return onVerify()
    }

    override suspend fun deleteAccount(password: String) = Unit
    override suspend fun report(body: ReportBody) = Unit
    override suspend fun block(userId: Long, name: String?) = Unit
    override suspend fun unblock(userId: Long) = Unit
    override suspend fun refreshBlocked(): List<BlockedUser> = blocked.value
}
