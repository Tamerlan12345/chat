package com.openmychat.mobile.features.auth

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.MarkEmailUnread
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.openmychat.mobile.R
import com.openmychat.mobile.features.account.accountFailureText
import com.openmychat.mobile.features.auth.RegistrationState.Step
import com.openmychat.mobile.features.auth.RegistrationValidation.Field
import com.openmychat.mobile.features.auth.RegistrationValidation.Problem
import com.openmychat.mobile.ui.components.CentyPrimaryButton
import com.openmychat.mobile.ui.components.CentyTextButton
import com.openmychat.mobile.ui.components.centyFieldColors
import com.openmychat.mobile.ui.theme.CentyTheme
import kotlinx.coroutines.delay
import java.util.Locale

/** What the registration screen can ask for; defaults keep previews and tests short. */
interface RegistrationActions {
    fun onEmailChange(value: String) {}
    fun onDisplayNameChange(value: String) {}
    fun onUsernameChange(value: String) {}
    fun onPasswordChange(value: String) {}
    fun onSubmit() {}
    fun onCodeChange(value: String) {}
    fun onVerify() {}
    fun onResend() {}
    fun onBackToForm() {}
    fun onClose() {}
}

/**
 * In-app registration over the login screen: the form, the e-mail code and «Заявка на рассмотрении».
 * A confirmed code that comes back signed in opens the app ([onSignedIn]).
 */
@Composable
fun RegistrationScreen(viewModel: RegistrationViewModel, onClose: () -> Unit, onSignedIn: () -> Unit) {
    val state by viewModel.state.collectAsState()
    val now by rememberClock()
    LaunchedEffect(state.signedIn) { if (state.signedIn) onSignedIn() }
    // System back on the code step returns to the form (the data stays); elsewhere it leaves.
    BackHandler(enabled = state.step == Step.CODE && !state.busy) { viewModel.backToForm() }
    val actions = remember(viewModel, onClose) {
        object : RegistrationActions {
            override fun onEmailChange(value: String) = viewModel.onEmailChange(value)
            override fun onDisplayNameChange(value: String) = viewModel.onDisplayNameChange(value)
            override fun onUsernameChange(value: String) = viewModel.onUsernameChange(value)
            override fun onPasswordChange(value: String) = viewModel.onPasswordChange(value)
            override fun onSubmit() = viewModel.submitForm()
            override fun onCodeChange(value: String) = viewModel.onCodeChange(value)
            override fun onVerify() = viewModel.verify()
            override fun onResend() = viewModel.resend()
            override fun onBackToForm() = viewModel.backToForm()
            override fun onClose() = onClose()
        }
    }
    RegistrationContent(state = state, now = now, actions = actions)
}

/** Wall-clock milliseconds, refreshed every second, for countdowns. */
@Composable
internal fun rememberClock(): State<Long> = produceState(System.currentTimeMillis()) {
    while (true) {
        delay(1_000)
        value = System.currentTimeMillis()
    }
}

@Composable
fun RegistrationContent(state: RegistrationState, now: Long, actions: RegistrationActions, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    Scaffold(
        modifier = modifier,
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    if (state.step != Step.PENDING) {
                        Text(stringResource(if (state.step == Step.FORM) R.string.register_title_form else R.string.register_title_code))
                    }
                },
                navigationIcon = {
                    if (state.step != Step.PENDING) {
                        IconButton(onClick = actions::onClose, enabled = !state.busy, modifier = Modifier.testTag("register-close")) {
                            Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.action_close))
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                    titleContentColor = tokens.textStrong,
                    navigationIconContentColor = tokens.textSecondary
                )
            )
        }
    ) { padding ->
        if (state.step == Step.PENDING) {
            AccountStatusContent(
                status = AccountStatus.SUBMITTED,
                onBackToLogin = actions::onClose,
                modifier = Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)
            )
            return@Scaffold
        }
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(top = 8.dp, bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Column(Modifier.widthIn(max = 440.dp).fillMaxWidth()) {
                when (state.step) {
                    Step.FORM -> FormStep(state, now, actions)
                    Step.CODE -> CodeStep(state, now, actions)
                    Step.PENDING -> Unit
                }
            }
        }
    }
}

@Composable
private fun FormStep(state: RegistrationState, now: Long, actions: RegistrationActions) {
    val tokens = CentyTheme.tokens
    val focus = LocalFocusManager.current
    var passwordVisible by remember { mutableStateOf(false) }
    val message = state.failure?.let { accountFailureText(it, now) }
    val submit = {
        focus.clearFocus()
        actions.onSubmit()
    }

    Text(stringResource(R.string.register_intro), style = MaterialTheme.typography.bodyMedium, color = tokens.textSecondary)
    Spacer(Modifier.height(16.dp))
    Card {
        message?.let { ErrorBox(it, Modifier.testTag("register-error")) }
        RegistrationField(
            value = state.email,
            onValueChange = actions::onEmailChange,
            label = R.string.register_email,
            placeholder = R.string.register_email_hint,
            problem = state.visibleProblem(Field.EMAIL),
            enabled = !state.busy,
            keyboard = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            onIme = { focus.moveFocus(FocusDirection.Down) },
            autofill = ContentType.EmailAddress,
            tag = "register-email"
        )
        RegistrationField(
            value = state.displayName,
            onValueChange = actions::onDisplayNameChange,
            label = R.string.register_name,
            placeholder = R.string.register_name_hint,
            problem = state.visibleProblem(Field.DISPLAY_NAME),
            enabled = !state.busy,
            keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next),
            onIme = { focus.moveFocus(FocusDirection.Down) },
            autofill = ContentType.PersonFullName,
            tag = "register-name"
        )
        RegistrationField(
            value = state.username,
            onValueChange = actions::onUsernameChange,
            label = R.string.register_username,
            placeholder = R.string.register_username_hint,
            problem = state.visibleProblem(Field.USERNAME),
            enabled = !state.busy,
            keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Next),
            onIme = { focus.moveFocus(FocusDirection.Down) },
            autofill = ContentType.NewUsername,
            tag = "register-username"
        )
        RegistrationField(
            value = state.password,
            onValueChange = actions::onPasswordChange,
            label = R.string.register_password,
            placeholder = R.string.register_password_hint,
            problem = state.visibleProblem(Field.PASSWORD),
            enabled = !state.busy,
            keyboard = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
            onIme = submit,
            autofill = ContentType.NewPassword,
            tag = "register-password",
            visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
            trailing = {
                IconButton(onClick = { passwordVisible = !passwordVisible }) {
                    Icon(
                        if (passwordVisible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                        contentDescription = stringResource(if (passwordVisible) R.string.login_hide_password else R.string.login_show_password)
                    )
                }
            }
        )
        Spacer(Modifier.height(4.dp))
        CentyPrimaryButton(
            text = stringResource(R.string.register_get_code),
            onClick = submit,
            enabled = !state.busy && !state.isWaiting(now),
            loading = state.busy,
            loadingDescription = stringResource(R.string.register_sending),
            modifier = Modifier.fillMaxWidth().testTag("register-submit")
        )
        CentyTextButton(onClick = actions::onClose, enabled = !state.busy, modifier = Modifier.fillMaxWidth().testTag("register-to-login")) {
            Text(stringResource(R.string.register_have_account), style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun CodeStep(state: RegistrationState, now: Long, actions: RegistrationActions) {
    val tokens = CentyTheme.tokens
    val focus = LocalFocusManager.current
    val message = state.failure?.let { accountFailureText(it, now) }
    val expired = state.isCodeExpired(now)
    val resendIn = state.secondsUntilResend(now)
    val verify = {
        focus.clearFocus()
        actions.onVerify()
    }

    Column(Modifier.fillMaxWidth().testTag("register-code-screen"), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Outlined.MarkEmailUnread, contentDescription = null, tint = tokens.accentText, modifier = Modifier.size(48.dp))
        Spacer(Modifier.height(12.dp))
        Text(
            stringResource(R.string.register_code_heading),
            style = MaterialTheme.typography.titleLarge,
            color = tokens.textStrong,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() }
        )
        Spacer(Modifier.height(4.dp))
        Text(
            stringResource(R.string.register_code_sent_to, RegistrationValidation.normalizedEmail(state.email)),
            style = MaterialTheme.typography.bodyMedium,
            color = tokens.textSecondary,
            textAlign = TextAlign.Center
        )
    }
    Spacer(Modifier.height(16.dp))
    Card {
        message?.let { ErrorBox(it, Modifier.testTag("register-code-error")) }
        OutlinedTextField(
            value = state.code,
            onValueChange = actions::onCodeChange,
            label = { Text(stringResource(R.string.register_code_label)) },
            singleLine = true,
            enabled = !state.busy,
            textStyle = MaterialTheme.typography.headlineSmall.copy(
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.3.em,
                textAlign = TextAlign.Center
            ),
            shape = RoundedCornerShape(8.dp),
            colors = centyFieldColors(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (state.canVerify) verify() }),
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentType = ContentType.SmsOtpCode }
                .testTag("register-code")
        )
        val seconds = state.secondsUntilExpiry(now)
        when {
            expired -> Text(stringResource(R.string.register_code_expired), style = MaterialTheme.typography.bodySmall, color = tokens.dangerText)
            seconds != null -> Text(
                stringResource(R.string.register_code_expires, String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60)),
                style = MaterialTheme.typography.bodySmall,
                color = tokens.textDim
            )
        }
        Spacer(Modifier.height(4.dp))
        CentyPrimaryButton(
            text = stringResource(R.string.register_verify),
            onClick = verify,
            enabled = state.canVerify && !expired,
            loading = state.busy,
            loadingDescription = stringResource(R.string.register_verifying),
            modifier = Modifier.fillMaxWidth().testTag("register-verify")
        )
        CentyTextButton(onClick = actions::onResend, enabled = state.canResend(now), modifier = Modifier.fillMaxWidth().testTag("register-resend")) {
            Text(
                if (resendIn > 0) stringResource(R.string.register_resend_in, formatCountdown(resendIn)) else stringResource(R.string.register_resend),
                style = MaterialTheme.typography.labelLarge,
                textAlign = TextAlign.Center
            )
        }
        CentyTextButton(
            onClick = {
                focus.clearFocus()
                actions.onBackToForm()
            },
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().testTag("register-back")
        ) {
            Text(stringResource(R.string.register_change_data), style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun RegistrationField(
    value: String,
    onValueChange: (String) -> Unit,
    label: Int,
    placeholder: Int,
    problem: Problem?,
    enabled: Boolean,
    keyboard: KeyboardOptions,
    onIme: () -> Unit,
    autofill: ContentType,
    tag: String,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    trailing: (@Composable () -> Unit)? = null
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(stringResource(label)) },
        placeholder = { Text(stringResource(placeholder)) },
        supportingText = problem?.let { { Text(problemText(it)) } },
        isError = problem != null,
        singleLine = true,
        enabled = enabled,
        trailingIcon = trailing,
        visualTransformation = visualTransformation,
        shape = RoundedCornerShape(8.dp),
        colors = centyFieldColors(),
        keyboardOptions = keyboard,
        keyboardActions = KeyboardActions(onNext = { onIme() }, onGo = { onIme() }),
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentType = autofill }
            .testTag(tag)
    )
}

@Composable
internal fun problemText(problem: Problem): String = stringResource(
    when (problem) {
        Problem.EMAIL_MISSING -> R.string.register_problem_email_missing
        Problem.EMAIL_INVALID -> R.string.register_problem_email_invalid
        Problem.NAME_SHORT -> R.string.register_problem_name_short
        Problem.NAME_LONG -> R.string.register_problem_name_long
        Problem.USERNAME_LENGTH -> R.string.register_problem_username_length
        Problem.USERNAME_CHARACTERS -> R.string.register_problem_username_characters
        Problem.PASSWORD_MISSING -> R.string.register_problem_password_missing
        Problem.PASSWORD_SHORT -> R.string.register_problem_password_short
        Problem.PASSWORD_LONG -> R.string.register_problem_password_long
    }
)

/** The login screen's card: one surface with a hairline, fields spaced 12 dp. */
@Composable
private fun Card(content: @Composable ColumnScope.() -> Unit) {
    val tokens = CentyTheme.tokens
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = tokens.card,
        border = BorderStroke(1.dp, tokens.border)
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}
