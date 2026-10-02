package com.openmychat.mobile.ui.components

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyTheme

/** A Material dialog for a decision that must interrupt (destructive or irreversible). */
@Composable
fun CentyConfirmDialog(
    title: String,
    message: String,
    confirmText: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    dismissText: String = stringResource(R.string.action_cancel),
    isDestructive: Boolean = false,
    confirmTestTag: String = "confirm"
) {
    val tokens = CentyTheme.tokens
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("confirm-dialog"),
        containerColor = tokens.elevated,
        titleContentColor = tokens.textStrong,
        textContentColor = tokens.textSecondary,
        title = { Text(text = title, style = MaterialTheme.typography.titleLarge) },
        text = { Text(text = message, style = MaterialTheme.typography.bodyMedium) },
        confirmButton = {
            Button(
                onClick = onConfirm,
                modifier = Modifier.testTag(confirmTestTag),
                colors = if (isDestructive) {
                    ButtonDefaults.buttonColors(containerColor = tokens.dangerFill, contentColor = Color.White)
                } else {
                    ButtonDefaults.buttonColors()
                }
            ) { Text(confirmText) }
        },
        dismissButton = { CentyTextButton(onClick = onDismiss) { Text(dismissText) } }
    )
}
