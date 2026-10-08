package com.openmychat.mobile.features.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.HourglassTop
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.components.CentyPrimaryButton
import com.openmychat.mobile.ui.theme.CentyTheme

/** Which registration state a screen explains. */
enum class AccountStatus {
    /** Just confirmed the e-mail; an administrator still has to approve the account. */
    SUBMITTED,

    /** `403 ACCOUNT_PENDING` on login. */
    PENDING,

    /** `403 ACCOUNT_REJECTED` on login. */
    REJECTED
}

/** «Заявка на рассмотрении» / «Заявка отклонена», opened from the login screen. */
@Composable
fun AccountStatusScreen(status: AccountStatus, onBackToLogin: () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            AccountStatusContent(status, onBackToLogin, Modifier.fillMaxSize())
        }
    }
}

/** A large symbol, the state as a heading, what happens next, and the way back to sign-in. */
@Composable
fun AccountStatusContent(status: AccountStatus, onBackToLogin: () -> Unit, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    val rejected = status == AccountStatus.REJECTED
    Column(
        modifier = modifier
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp)
            .testTag("account-status"),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                Modifier
                    .size(88.dp)
                    .background(if (rejected) tokens.dangerSoft else tokens.primarySoft, CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = if (rejected) Icons.Outlined.Block else Icons.Outlined.HourglassTop,
                    contentDescription = null,
                    tint = if (rejected) tokens.dangerText else tokens.accentText,
                    modifier = Modifier.size(44.dp)
                )
            }
            Spacer(Modifier.height(24.dp))
            Text(
                text = stringResource(if (rejected) R.string.account_rejected_title else R.string.account_pending_title),
                style = MaterialTheme.typography.headlineSmall,
                color = tokens.textStrong,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() }
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = stringResource(
                    when (status) {
                        AccountStatus.SUBMITTED -> R.string.account_pending_message
                        AccountStatus.PENDING -> R.string.account_pending_login_message
                        AccountStatus.REJECTED -> R.string.account_rejected_message
                    }
                ),
                style = MaterialTheme.typography.bodyLarge,
                color = tokens.textSecondary,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(28.dp))
            CentyPrimaryButton(
                text = stringResource(R.string.account_back_to_login),
                onClick = onBackToLogin,
                modifier = Modifier.fillMaxWidth().testTag("account-status-back")
            )
        }
    }
}
