package com.openmychat.mobile.features.account

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.res.stringResource
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.components.CentyConfirmDialog
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import com.openmychat.mobile.ui.components.rememberHaptics

/** «Заблокировать пользователя?» — what a block means, before it is sent. */
@Composable
fun BlockConfirmDialog(name: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    CentyConfirmDialog(
        title = stringResource(R.string.safety_block_title),
        message = stringResource(R.string.safety_block_message, name),
        confirmText = stringResource(R.string.safety_block),
        isDestructive = true,
        confirmTestTag = "confirm-block",
        onConfirm = onConfirm,
        onDismiss = onDismiss
    )
}

/** Shows the outcome of a block or unblock in the app's snackbar. */
@Composable
fun SafetyNotices(blocks: BlockController) {
    val notice by blocks.notice.collectAsState()
    val snackbar = LocalSnackbarHostState.current
    val haptics = rememberHaptics()
    val text = when (val shown = notice) {
        null -> null
        SafetyNotice.Blocked -> stringResource(R.string.safety_blocked)
        SafetyNotice.Unblocked -> stringResource(R.string.safety_unblocked)
        is SafetyNotice.Failed -> accountFailureText(shown.failure, System.currentTimeMillis())
            ?: stringResource(R.string.account_error_unavailable)
    }
    LaunchedEffect(notice) {
        if (notice == null || text == null) return@LaunchedEffect
        if (notice is SafetyNotice.Failed) haptics.reject() else haptics.confirm()
        // Cleared after the snackbar: clearing first would restart this effect and cancel it.
        snackbar.showSnackbar(text)
        blocks.noticeShown()
    }
}
