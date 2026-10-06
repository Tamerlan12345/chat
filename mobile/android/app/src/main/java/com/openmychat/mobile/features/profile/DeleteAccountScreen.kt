package com.openmychat.mobile.features.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.features.account.accountFailureText
import com.openmychat.mobile.ui.components.CentyConfirmDialog
import com.openmychat.mobile.ui.components.CentyDangerButton
import com.openmychat.mobile.ui.components.centyFieldColors
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentySpace
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.features.auth.rememberClock

@Composable
fun DeleteAccountScreen(viewModel: DeleteAccountViewModel, onBack: () -> Unit, onDeleted: () -> Unit) {
    val state by viewModel.state.collectAsState()
    val unsent by viewModel.unsentCount.collectAsState()
    LaunchedEffect(state.deleted) { if (state.deleted) onDeleted() }
    DeleteAccountContent(state, onBack = onBack, onPasswordChange = viewModel::onPasswordChange, onDelete = viewModel::delete, unsentCount = unsent)
}

/**
 * Deletion asks for the password again, says plainly what is lost, and confirms once more in a dialog.
 * The button is the danger fill (the one destructive action of the screen); while deleting it waits.
 */
@Composable
fun DeleteAccountContent(
    state: DeleteAccountState,
    onBack: () -> Unit,
    onPasswordChange: (String) -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
    initiallyConfirming: Boolean = false,
    /** Unsent messages that go with the account: the confirmation names them. */
    unsentCount: Int = 0
) {
    val tokens = CentyTheme.tokens
    val focus = LocalFocusManager.current
    var passwordVisible by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(initiallyConfirming) }
    // Ticks every second: a server wait (429) counts down in the error and frees the button at 0.
    val now by rememberClock()
    val canDelete = state.canDeleteAt(now)
    val ask = {
        focus.clearFocus()
        if (canDelete) confirming = true
    }
    Scaffold(
        modifier = modifier.testTag("delete-account"),
        containerColor = tokens.list,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.delete_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack, enabled = !state.deleting) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = tokens.list,
                    titleContentColor = tokens.textStrong,
                    navigationIconContentColor = tokens.textSecondary
                )
            )
        }
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(top = 8.dp, bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Column(Modifier.widthIn(max = 600.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                val shape = RoundedCornerShape(CentyRadius.card)
                // A soft danger tone, no outline (polish pass, rule 1).
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(tokens.dangerSoft, shape)
                        .padding(CentySpace.l)
                        .testTag("delete-warning")
                ) {
                    Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = tokens.dangerText, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(12.dp))
                    Text(stringResource(R.string.delete_warning), style = MaterialTheme.typography.bodyMedium, color = tokens.textStrong)
                }
                OutlinedTextField(
                    value = state.password,
                    onValueChange = onPasswordChange,
                    label = { Text(stringResource(R.string.delete_password_label)) },
                    singleLine = true,
                    enabled = !state.deleting,
                    isError = state.failure != null,
                    supportingText = state.failure?.let { failure ->
                        accountFailureText(failure, now)?.let { text ->
                            { Text(text, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("delete-error")) }
                        }
                    },
                    visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { passwordVisible = !passwordVisible }) {
                            Icon(
                                if (passwordVisible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                contentDescription = stringResource(if (passwordVisible) R.string.login_hide_password else R.string.login_show_password)
                            )
                        }
                    },
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { ask() }),
                    shape = RoundedCornerShape(CentyRadius.control),
                    colors = centyFieldColors(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentType = ContentType.Password }
                        .testTag("delete-password")
                )
                CentyDangerButton(
                    text = stringResource(if (state.deleting) R.string.delete_in_progress else R.string.profile_delete_account),
                    onClick = ask,
                    enabled = canDelete,
                    modifier = Modifier.fillMaxWidth().testTag("delete-confirm")
                )
            }
        }
    }

    if (confirming) {
        CentyConfirmDialog(
            title = stringResource(R.string.delete_dialog_title),
            message = stringResource(R.string.delete_dialog_message).let { base ->
                if (unsentCount > 0) pluralStringResource(R.plurals.profile_logout_unsent, unsentCount, unsentCount) + "\n\n" + base else base
            },
            confirmText = stringResource(R.string.action_delete),
            isDestructive = true,
            confirmTestTag = "delete-final",
            onConfirm = {
                confirming = false
                onDelete()
            },
            onDismiss = { confirming = false }
        )
    }
}
