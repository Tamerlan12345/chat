package com.openmychat.mobile.features.auth

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp

@Composable
fun ChangePasswordDialog(
    initialOldPassword: String = "",
    isLoading: Boolean = false,
    errorMessage: String? = null,
    onDismiss: (() -> Unit)? = null,
    onSubmit: (oldPassword: String, newPassword: String) -> Unit
) {
    var oldPassword by remember { mutableStateOf(initialOldPassword) }
    var newPassword by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }

    var oldPasswordVisible by remember { mutableStateOf(false) }
    var newPasswordVisible by remember { mutableStateOf(false) }

    var validationError by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { onDismiss?.invoke() },
        icon = {
            Icon(
                imageVector = Icons.Default.Lock,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary
            )
        },
        title = {
            Text(
                text = "Обязательная смена пароля",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text(
                    text = "Администратор запросил смену пароля для продолжения работы в CentyChat.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )

                OutlinedTextField(
                    value = oldPassword,
                    onValueChange = { oldPassword = it },
                    label = { Text("Текущий пароль") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    visualTransformation = if (oldPasswordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { oldPasswordVisible = !oldPasswordVisible }) {
                            Icon(
                                imageVector = if (oldPasswordVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                contentDescription = null
                            )
                        }
                    }
                )

                OutlinedTextField(
                    value = newPassword,
                    onValueChange = { newPassword = it },
                    label = { Text("Новый пароль (мин. 8 симв.)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    visualTransformation = if (newPasswordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { newPasswordVisible = !newPasswordVisible }) {
                            Icon(
                                imageVector = if (newPasswordVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                contentDescription = null
                            )
                        }
                    }
                )

                OutlinedTextField(
                    value = confirmPassword,
                    onValueChange = { confirmPassword = it },
                    label = { Text("Повторите новый пароль") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    visualTransformation = PasswordVisualTransformation()
                )

                val displayError = validationError ?: errorMessage
                if (displayError != null) {
                    Text(
                        text = displayError,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    when {
                        oldPassword.isBlank() -> validationError = "Введите текущий пароль"
                        newPassword.length < 8 -> validationError = "Длина пароля должна быть не менее 8 символов"
                        newPassword != confirmPassword -> validationError = "Пароли не совпадают"
                        else -> {
                            validationError = null
                            onSubmit(oldPassword, newPassword)
                        }
                    }
                },
                enabled = !isLoading
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp
                    )
                } else {
                    Text("Сменить пароль")
                }
            }
        },
        dismissButton = if (onDismiss != null) {
            {
                TextButton(onClick = onDismiss, enabled = !isLoading) {
                    Text("Отмена")
                }
            }
        } else null
    )
}
