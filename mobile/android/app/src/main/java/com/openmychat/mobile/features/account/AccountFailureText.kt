package com.openmychat.mobile.features.account

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.openmychat.mobile.R
import com.openmychat.mobile.features.auth.formatCountdown

/** The Russian text for [failure] at [nowMillis], or null once a wait is over. */
@Composable
fun accountFailureText(failure: AccountFailure, nowMillis: Long): String? = when (failure) {
    AccountFailure.Offline -> stringResource(R.string.account_error_offline)
    AccountFailure.MailNotConfigured -> stringResource(R.string.account_error_mail_not_configured)
    is AccountFailure.Throttled -> failure.secondsLeft(nowMillis).takeIf { it > 0 }
        ?.let { stringResource(R.string.account_error_throttled, formatCountdown(it)) }
    is AccountFailure.InvalidInput -> failure.text.ifEmpty { stringResource(R.string.account_error_invalid_input) }
    is AccountFailure.Conflict -> when (failure.kind) {
        AccountFailure.ConflictKind.USERNAME_TAKEN -> stringResource(R.string.account_error_username_taken)
        AccountFailure.ConflictKind.EMAIL_TAKEN -> stringResource(R.string.account_error_email_taken)
        AccountFailure.ConflictKind.OTHER -> failure.text.ifEmpty { stringResource(R.string.account_error_conflict) }
    }
    is AccountFailure.WrongCode -> {
        val base = failure.text.ifEmpty { stringResource(R.string.account_error_wrong_code) }.trimEnd('.')
        failure.attemptsLeft?.let { stringResource(R.string.account_error_attempts_left, base, it) } ?: "$base."
    }
    AccountFailure.CodeExpired -> stringResource(R.string.account_error_code_expired)
    AccountFailure.MailSendFailed -> stringResource(R.string.account_error_mail_send_failed)
    AccountFailure.WrongPassword -> stringResource(R.string.account_error_wrong_password)
    AccountFailure.LastAdmin -> stringResource(R.string.account_error_last_admin)
    AccountFailure.StorageUnavailable -> stringResource(R.string.account_error_storage)
    AccountFailure.Unavailable -> stringResource(R.string.account_error_unavailable)
}
