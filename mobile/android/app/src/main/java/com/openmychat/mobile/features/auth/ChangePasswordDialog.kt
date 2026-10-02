package com.openmychat.mobile.features.auth

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.components.CentyTextButton
import com.openmychat.mobile.ui.components.centyFieldColors
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme

/** The policy the dialog checks live; the server enforces it again. */
internal object PasswordPolicy {
    const val MIN_LENGTH = 8
    fun longEnough(new: String) = new.length >= MIN_LENGTH
    fun differs(current: String, new: String) = new.isNotEmpty() && new != current
    fun matches(new: String, confirm: String) = new.isNotEmpty() && new == confirm
    fun satisfied(current: String, new: String, confirm: String) =
        current.isNotBlank() && longEnough(new) && differs(current, new) && matches(new, confirm)
}

/** Passed as the error to show the generic «Не удалось сменить пароль» from strings.xml. */
const val PASSWORD_CHANGE_GENERIC_ERROR = ""

/**
 * Forced (or voluntary) password change. The rules tick off live while typing; «Сменить пароль»
 * is enabled once every rule holds. [onDismiss] null means the dialog cannot be dismissed.
 */
@Composable
fun ChangePasswordDialog(
    initialOldPassword: String = "",
    isLoading: Boolean = false,
    errorMessage: String? = null,
    onDismiss: (() -> Unit)? = null,
    onSubmit: (oldPassword: String, newPassword: String) -> Unit
) {
    val tokens = CentyTheme.tokens
    var current by remember { mutableStateOf(initialOldPassword) }
    var new by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var reveal by remember { mutableStateOf(false) }
    val ready = PasswordPolicy.satisfied(current, new, confirm)

    AlertDialog(
        onDismissRequest = { onDismiss?.invoke() },
        containerColor = tokens.elevated,
        titleContentColor = tokens.textStrong,
        textContentColor = tokens.textSecondary,
        icon = { Icon(Icons.Outlined.Lock, contentDescription = null, tint = tokens.accentText) },
        title = { Text(stringResource(R.string.must_change_password_title), style = MaterialTheme.typography.titleLarge) },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text(stringResource(R.string.must_change_password_desc), style = MaterialTheme.typography.bodyMedium)
                val transformation = if (reveal) VisualTransformation.None else PasswordVisualTransformation()
                val toggle: @Composable () -> Unit = {
                    IconButton(onClick = { reveal = !reveal }) {
                        Icon(
                            if (reveal) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                            contentDescription = stringResource(if (reveal) R.string.login_hide_password else R.string.login_show_password)
                        )
                    }
                }
                PasswordField(current, { current = it }, stringResource(R.string.current_password), transformation, !isLoading)
                PasswordField(new, { new = it }, stringResource(R.string.new_password), transformation, !isLoading, trailing = toggle)
                PasswordField(confirm, { confirm = it }, stringResource(R.string.confirm_new_password), transformation, !isLoading)

                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Rule(stringResource(R.string.password_rule_length), PasswordPolicy.longEnough(new))
                    Rule(stringResource(R.string.password_rule_differs), PasswordPolicy.differs(current, new))
                    Rule(stringResource(R.string.password_rule_match), PasswordPolicy.matches(new, confirm))
                }

                if (errorMessage != null) {
                    Text(
                        errorMessage.ifEmpty { stringResource(R.string.password_error_failed) },
                        style = MaterialTheme.typography.bodyMedium,
                        color = tokens.dangerText,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                    )
                }
            }
        },
        confirmButton = {
            Button(onClick = { onSubmit(current, new) }, enabled = ready && !isLoading, shape = RoundedCornerShape(CentyRadius.control)) {
                if (isLoading) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = tokens.textDim)
                } else {
                    Text(stringResource(R.string.change_password_action))
                }
            }
        },
        dismissButton = onDismiss?.let {
            { CentyTextButton(onClick = it, enabled = !isLoading) { Text(stringResource(R.string.action_cancel)) } }
        }
    )
}

@Composable
private fun PasswordField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    transformation: VisualTransformation,
    enabled: Boolean,
    trailing: (@Composable () -> Unit)? = null
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        enabled = enabled,
        visualTransformation = transformation,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
        trailingIcon = trailing,
        shape = RoundedCornerShape(CentyRadius.control),
        colors = centyFieldColors(),
        modifier = Modifier.fillMaxWidth()
    )
}

@Composable
private fun Rule(text: String, met: Boolean) {
    val tokens = CentyTheme.tokens
    val color by animateColorAsState(if (met) tokens.successText else tokens.textDim, CentyMotion.base(), label = "rule")
    val state = stringResource(if (met) R.string.password_rule_met else R.string.password_rule_unmet)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.semantics(mergeDescendants = true) { stateDescription = state }
    ) {
        Icon(if (met) Icons.Rounded.CheckCircle else Icons.Outlined.Circle, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = color)
    }
}
