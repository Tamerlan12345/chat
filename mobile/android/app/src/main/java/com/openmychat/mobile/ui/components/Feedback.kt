package com.openmychat.mobile.ui.components

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView

/**
 * One app-wide snackbar host (Material: transient feedback is a snackbar, never a Toast). Provided
 * by MainActivity; screens post through it so a message survives navigation between tabs.
 */
val LocalSnackbarHostState = staticCompositionLocalOf { SnackbarHostState() }

@Composable
fun CentySnackbarHost(state: SnackbarHostState, modifier: Modifier = Modifier) {
    SnackbarHost(hostState = state, modifier = modifier) { data ->
        Snackbar(
            snackbarData = data,
            shape = androidx.compose.material3.MaterialTheme.shapes.small
        )
    }
}

/**
 * Haptics from the brief: a light tick on send, a confirmation on «Ознакомлен», a warning on a
 * failure, and the standard long-press. Uses the platform constants (no vibrator permission use).
 */
class Haptics(private val view: View) {
    fun tick() = perform(HapticFeedbackConstants.KEYBOARD_TAP)
    fun longPress() = perform(HapticFeedbackConstants.LONG_PRESS)
    fun confirm() = perform(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
    fun reject() = perform(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)

    private fun perform(constant: Int) {
        view.performHapticFeedback(constant)
    }
}

@Composable
fun rememberHaptics(): Haptics {
    val view = LocalView.current
    return remember(view) { Haptics(view) }
}
