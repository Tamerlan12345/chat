package com.openmychat.mobile.features.account

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarVisuals
import com.openmychat.mobile.features.auth.rememberClock
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

/**
 * Shows the outcome of a block or unblock in the app's snackbar. A server wait (429) counts down in
 * the snackbar while it is on screen: its text is read from a ticking state, not fixed when shown.
 */
@Composable
fun SafetyNotices(blocks: BlockController) {
    val notice by blocks.notice.collectAsState()
    val snackbar = LocalSnackbarHostState.current
    val haptics = rememberHaptics()
    val now by rememberClock()
    val text = when (val shown = notice) {
        null -> null
        SafetyNotice.Blocked -> stringResource(R.string.safety_blocked)
        SafetyNotice.Unblocked -> stringResource(R.string.safety_unblocked)
        is SafetyNotice.Failed -> accountFailureText(shown.failure, now)
            ?: stringResource(R.string.account_error_unavailable)
    }
    val liveText = rememberUpdatedState(text.orEmpty())
    LaunchedEffect(notice) {
        if (notice == null || text == null) return@LaunchedEffect
        if (notice is SafetyNotice.Failed) haptics.reject() else haptics.confirm()
        // Cleared after the snackbar: clearing first would restart this effect and cancel it.
        snackbar.showSnackbar(TickingSnackbar { liveText.value })
        blocks.noticeShown()
    }
}

/** Snackbar text read when drawn, so a countdown in it keeps ticking. */
private class TickingSnackbar(private val text: () -> String) : SnackbarVisuals {
    override val message: String get() = text()
    override val actionLabel: String? get() = null
    override val withDismissAction: Boolean get() = false
    override val duration: SnackbarDuration get() = SnackbarDuration.Short
}
