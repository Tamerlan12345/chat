package com.openmychat.mobile.features.auth

import android.provider.Settings
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.components.CentyPrimaryButton
import com.openmychat.mobile.ui.components.CentyTextButton
import com.openmychat.mobile.ui.components.centyFieldColors
import com.openmychat.mobile.ui.theme.CentyTheme
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** Desktop motion curve `cubic-bezier(.22,1,.36,1)`, "slow" 280 ms. */
private val BrandEasing = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)
private const val MARK_INTRO_MS = 280

/**
 * The app's front door: brand lockup, one card with login and password, full-width «Войти», and a
 * quiet «Зарегистрироваться» under the card. The server is fixed at build time, so there is no
 * server field and no "change server" control. A registration that is pending or rejected opens
 * its own screen ([onAccountState]) instead of an error.
 */
@Composable
fun LoginScreen(
    viewModel: LoginViewModel,
    onLoginSuccess: () -> Unit,
    onRegister: () -> Unit = {},
    onAccountState: (rejected: Boolean) -> Unit = {}
) {
    val uiState by viewModel.uiState.collectAsState()
    val canSubmit by viewModel.canSubmit.collectAsState()
    val retryAfter by viewModel.retryAfterSeconds.collectAsState()
    val companyName by viewModel.companyName.collectAsState()
    val mustChangePasswordVisible by viewModel.mustChangePasswordDialogVisible.collectAsState()
    val changePasswordLoading by viewModel.changePasswordLoading.collectAsState()
    val changePasswordError by viewModel.changePasswordError.collectAsState()

    // The fields mirror the ViewModel in plain (not saveable) state: typing stays responsive and the
    // password never enters the saved-instance-state bundle.
    var username by remember { mutableStateOf(viewModel.username.value) }
    var password by remember { mutableStateOf(viewModel.password.value) }
    var passwordVisible by remember { mutableStateOf(false) }

    val focusManager = LocalFocusManager.current
    val isSigningIn = uiState is LoginUiState.Loading
    val submit = {
        if (canSubmit) {
            focusManager.clearFocus()
            viewModel.submit()
        }
    }

    LaunchedEffect(viewModel) { viewModel.onScreenShown() }
    // The ViewModel drops the password after a sign-in attempt (e.g. a forced password change);
    // the field follows, so it neither keeps showing nor resubmits it.
    LaunchedEffect(viewModel) {
        viewModel.password.collect { if (it.isEmpty()) password = "" }
    }
    LaunchedEffect(uiState) {
        val state = uiState
        if (state is LoginUiState.Success) onLoginSuccess()
        if (state is LoginUiState.Error && (state.error == LoginError.AccountPending || state.error == LoginError.AccountRejected)) {
            viewModel.onAccountStateShown()
            onAccountState(state.error == LoginError.AccountRejected)
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding() // status/navigation bars, cutouts and the keyboard
        ) {
            // Content sits in the upper third; on short windows (keyboard, landscape) it scrolls.
            val topGap = (maxHeight * 0.08f).coerceIn(16.dp, 72.dp)
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp)
                    .padding(top = topGap, bottom = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                BrandHeader(
                    companyName = companyName ?: stringResource(R.string.login_company_fallback),
                    animate = !viewModel.introPlayed,
                    onIntroPlayed = { viewModel.introPlayed = true }
                )

                Spacer(Modifier.height(32.dp))

                LoginCard(
                    username = username,
                    password = password,
                    passwordVisible = passwordVisible,
                    isSigningIn = isSigningIn,
                    canSubmit = canSubmit,
                    error = (uiState as? LoginUiState.Error)?.error,
                    retryAfterSeconds = retryAfter,
                    onUsernameChange = {
                        username = it
                        viewModel.onUsernameChange(it)
                    },
                    onPasswordChange = {
                        password = it
                        viewModel.onPasswordChange(it)
                    },
                    onTogglePasswordVisibility = { passwordVisible = !passwordVisible },
                    onNext = { focusManager.moveFocus(FocusDirection.Down) },
                    onSubmit = submit
                )

                Spacer(Modifier.height(12.dp))
                // A text button: registering must not compete with «Войти».
                CentyTextButton(
                    onClick = onRegister,
                    enabled = !isSigningIn,
                    modifier = Modifier
                        .widthIn(max = 440.dp)
                        .fillMaxWidth()
                        .testTag("login-register")
                ) {
                    Text(stringResource(R.string.login_register), style = MaterialTheme.typography.labelLarge)
                }
            }
        }

        if (mustChangePasswordVisible) {
            ChangePasswordDialog(
                initialOldPassword = viewModel.lastEnteredPassword,
                isLoading = changePasswordLoading,
                errorMessage = changePasswordError,
                onDismiss = { viewModel.dismissChangePasswordDialog() },
                onSubmit = { oldPass, newPass -> viewModel.changePassword(oldPass, newPass) }
            )
        }
    }
}

@Composable
private fun BrandHeader(companyName: String, animate: Boolean, onIntroPlayed: () -> Unit) {
    val reduceMotion = rememberReduceMotion()
    val play = animate && !reduceMotion
    val alpha = remember { Animatable(if (play) 0f else 1f) }
    val scale = remember { Animatable(if (play) 0.92f else 1f) }
    LaunchedEffect(Unit) {
        onIntroPlayed()
        if (play) {
            coroutineScope {
                launch { alpha.animateTo(1f, tween(MARK_INTRO_MS, easing = BrandEasing)) }
                launch { scale.animateTo(1f, tween(MARK_INTRO_MS, easing = BrandEasing)) }
            }
        }
    }

    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Image(
            painter = painterResource(R.drawable.ic_brand_mark),
            contentDescription = null, // the wordmark below names the app
            modifier = Modifier
                .size(72.dp)
                .alpha(alpha.value)
                .scale(scale.value)
        )
        Spacer(Modifier.height(16.dp))
        Text(
            text = buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("Centy") }
                withStyle(SpanStyle(fontWeight = FontWeight.Normal)) { append("Chat") }
            },
            style = MaterialTheme.typography.headlineMedium.copy(letterSpacing = (-0.02).em),
            color = CentyTheme.tokens.textStrong,
            modifier = Modifier.semantics { heading() }
        )
        Spacer(Modifier.height(4.dp))
        // Server-provided text: plain Text only (sanitised in the ViewModel), never markup or links.
        Text(
            text = companyName,
            style = MaterialTheme.typography.bodyMedium,
            color = CentyTheme.tokens.textSecondary,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun LoginCard(
    username: String,
    password: String,
    passwordVisible: Boolean,
    isSigningIn: Boolean,
    canSubmit: Boolean,
    error: LoginError?,
    retryAfterSeconds: Long,
    onUsernameChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onTogglePasswordVisibility: () -> Unit,
    onNext: () -> Unit,
    onSubmit: () -> Unit
) {
    val tokens = CentyTheme.tokens
    Surface(
        modifier = Modifier
            .widthIn(max = 440.dp)
            .fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = tokens.card,
        border = BorderStroke(1.dp, tokens.border)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            AnimatedVisibility(
                visible = error != null,
                enter = fadeIn(tween(180)) + expandVertically(tween(180)),
                exit = fadeOut(tween(120)) + shrinkVertically(tween(120))
            ) {
                // Keep the last error while the box animates out.
                var shown by remember { mutableStateOf(error) }
                if (error != null) shown = error
                shown?.let { ErrorBox(text = errorText(it, retryAfterSeconds)) }
            }

            OutlinedTextField(
                value = username,
                onValueChange = onUsernameChange,
                label = { Text(stringResource(R.string.username)) },
                leadingIcon = { Icon(Icons.Outlined.Person, contentDescription = null) },
                singleLine = true,
                enabled = !isSigningIn,
                shape = RoundedCornerShape(8.dp),
                colors = fieldColors(),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Next
                ),
                keyboardActions = KeyboardActions(onNext = { onNext() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentType = ContentType.Username }
            )

            OutlinedTextField(
                value = password,
                onValueChange = onPasswordChange,
                label = { Text(stringResource(R.string.password)) },
                leadingIcon = { Icon(Icons.Outlined.Lock, contentDescription = null) },
                trailingIcon = {
                    IconButton(onClick = onTogglePasswordVisibility, enabled = !isSigningIn) {
                        Icon(
                            imageVector = if (passwordVisible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                            contentDescription = stringResource(
                                if (passwordVisible) R.string.login_hide_password else R.string.login_show_password
                            )
                        )
                    }
                },
                singleLine = true,
                enabled = !isSigningIn,
                shape = RoundedCornerShape(8.dp),
                colors = fieldColors(),
                visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Go
                ),
                keyboardActions = KeyboardActions(onGo = { onSubmit() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentType = ContentType.Password }
            )

            Spacer(Modifier.height(4.dp))

            SubmitButton(isSigningIn = isSigningIn, enabled = canSubmit, onClick = onSubmit)
        }
    }
}

@Composable
private fun SubmitButton(isSigningIn: Boolean, enabled: Boolean, onClick: () -> Unit) {
    // Индикатор встаёт на место подписи; кнопка не меняет ни размер, ни положение.
    CentyPrimaryButton(
        text = stringResource(R.string.login),
        onClick = onClick,
        enabled = enabled,
        loading = isSigningIn,
        loadingDescription = stringResource(R.string.login_in_progress),
        modifier = Modifier.fillMaxWidth()
    )
}

/** Danger-soft box with a hairline, like desktop `.login-error-box`; announced politely. */
@Composable
internal fun ErrorBox(text: String, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = modifier
            .fillMaxWidth()
            // A soft danger tone, no outline (polish pass, rule 1).
            .background(tokens.dangerSoft, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 12.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Icon(
            imageVector = Icons.Outlined.ErrorOutline,
            contentDescription = null,
            tint = tokens.dangerText,
            modifier = Modifier
                .padding(top = 1.dp)
                .size(18.dp)
        )
        Text(text = text, color = tokens.dangerText, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun errorText(error: LoginError, retryAfterSeconds: Long): String = when (error) {
    LoginError.EmptyFields -> stringResource(R.string.login_error_empty)
    LoginError.InvalidCredentials -> stringResource(R.string.login_error_invalid_credentials)
    LoginError.Throttled ->
        if (retryAfterSeconds > 0) stringResource(R.string.login_error_throttled, formatCountdown(retryAfterSeconds))
        else stringResource(R.string.login_error_throttled_done)
    LoginError.ServerBusy ->
        if (retryAfterSeconds > 0) stringResource(R.string.login_error_busy, formatCountdown(retryAfterSeconds))
        else stringResource(R.string.login_error_busy_done)
    LoginError.Offline -> stringResource(R.string.login_error_offline)
    // Shown on their own screens; the text only covers the instant before navigation.
    LoginError.AccountPending -> stringResource(R.string.account_pending_login_message)
    LoginError.AccountRejected -> stringResource(R.string.account_rejected_message)
    LoginError.InsecureConnection -> stringResource(R.string.login_error_insecure)
    LoginError.StorageUnavailable -> stringResource(R.string.login_error_storage)
    LoginError.Unexpected -> stringResource(R.string.login_error_unexpected)
}

@Composable
private fun fieldColors() = centyFieldColors()

/** "Remove animations" (animator duration scale 0) turns the intro off entirely. */
@Composable
private fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
}
