package com.openmychat.mobile.features.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.components.CentyConfirmDialog
import com.openmychat.mobile.ui.theme.StatusAway
import com.openmychat.mobile.ui.theme.StatusDnd
import com.openmychat.mobile.ui.theme.StatusOnline

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(
    viewModel: ProfileViewModel,
    onLoggedOut: () -> Unit
) {
    val uiState by viewModel.uiState.collectAsState()
    val currentUser = (uiState as? ProfileUiState.Content)?.user
    val customStatusInput = uiState.customStatusInput
    val wakeCooldown = uiState.wakeCooldownSeconds
    val isSaving = uiState.isSaving
    val logoutError by viewModel.logoutError.collectAsState()
    val storageError by viewModel.storageError.collectAsState()

    var showLogoutDialog by remember { mutableStateOf(false) }
    var wakeTargetInput by remember { mutableStateOf("") }

    val scrollState = rememberScrollState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Профиль", fontWeight = FontWeight.Bold) },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface
                )
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .consumeWindowInsets(innerPadding)
                .verticalScroll(scrollState)
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            val user = currentUser

            // Avatar & Name Header
            CentyAvatar(
                name = user?.fullName ?: "Пользователь",
                avatarUrl = user?.avatarUrl,
                status = user?.status ?: UserStatus.ONLINE,
                size = 96.dp
            )

            Spacer(modifier = Modifier.height(12.dp))

            Text(
                text = user?.fullName ?: "Загрузка…",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold
            )

            if (!user?.jobTitle.isNullOrBlank()) {
                Text(
                    text = user.jobTitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            if (!user?.departmentName.isNullOrBlank()) {
                Text(
                    text = user.departmentName,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary
                )
            }

            Spacer(modifier = Modifier.height(20.dp))

            // Presence Status Selection Chips
            Text(
                text = "Статус присутствия",
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.align(Alignment.Start)
            )

            Spacer(modifier = Modifier.height(8.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                StatusChip(
                    label = "В сети",
                    color = StatusOnline,
                    isSelected = user?.status == UserStatus.ONLINE,
                    onClick = { viewModel.setStatus(UserStatus.ONLINE) },
                    modifier = Modifier.weight(1f)
                )
                StatusChip(
                    label = "Отошел",
                    color = StatusAway,
                    isSelected = user?.status == UserStatus.AWAY,
                    onClick = { viewModel.setStatus(UserStatus.AWAY) },
                    modifier = Modifier.weight(1f)
                )
                StatusChip(
                    label = "Не беспокоить",
                    color = StatusDnd,
                    isSelected = user?.status == UserStatus.DND,
                    onClick = { viewModel.setStatus(UserStatus.DND) },
                    modifier = Modifier.weight(1f)
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Custom Status Input
            OutlinedTextField(
                value = customStatusInput,
                onValueChange = { viewModel.updateCustomStatusInput(it) },
                label = { Text("Пользовательский статус") },
                placeholder = { Text("Чем вы сейчас заняты?") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                trailingIcon = {
                    IconButton(
                        onClick = { viewModel.saveCustomStatus() },
                        enabled = !isSaving
                    ) {
                        if (isSaving) {
                            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(Icons.Default.Save, contentDescription = "Сохранить")
                        }
                    }
                }
            )

            Spacer(modifier = Modifier.height(24.dp))

            // User Info Card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Учетные данные", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)

                    InfoRow(label = "Логин", value = user?.username ?: "-")
                    InfoRow(label = "Компания", value = user?.company ?: "АО СК «Сентрас Иншуранс»")
                    if (user?.uin != null) InfoRow(label = "UIN", value = user.uin.toString())
                    if (!user?.extension.isNullOrBlank()) InfoRow(label = "Внутренний номер", value = user.extension)
                    if (!user?.email.isNullOrBlank()) InfoRow(label = "Email", value = user.email)
                    if (!user?.phone.isNullOrBlank()) InfoRow(label = "Телефон", value = user.phone)
                }
            }

            Spacer(modifier = Modifier.height(20.dp))

            // Wake Buzzer Test Section
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Default.NotificationsActive,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Побудка (Wake Buzzer)", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                    }

                    Spacer(modifier = Modifier.height(6.dp))

                    Text(
                        text = "Привлечение внимания коллеги с виброоткликом и звуком. Кулдаун: 60 секунд.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    Spacer(modifier = Modifier.height(10.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        OutlinedTextField(
                            value = wakeTargetInput,
                            onValueChange = { wakeTargetInput = it },
                            label = { Text("ID сотрудника") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )

                        Spacer(modifier = Modifier.width(8.dp))

                        Button(
                            onClick = {
                                val targetId = wakeTargetInput.toLongOrNull()
                                if (targetId != null) {
                                    viewModel.sendWakeToColleague(targetId)
                                }
                            },
                            enabled = wakeCooldown == 0 && wakeTargetInput.isNotBlank(),
                            modifier = Modifier.height(56.dp)
                        ) {
                            if (wakeCooldown > 0) {
                                Text("${wakeCooldown}с")
                            } else {
                                Text("Позвать")
                            }
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(24.dp))

            storageError?.let { error ->
                Text(
                    text = error,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(8.dp))
            }

            logoutError?.let { error ->
                Text(
                    text = error,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.fillMaxWidth()
                )
            }

            // Logout Button
            OutlinedButton(
                onClick = { showLogoutDialog = true },
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth().height(48.dp)
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ExitToApp,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text("Выйти из учетной записи")
            }

            Spacer(modifier = Modifier.height(16.dp))
        }

        if (showLogoutDialog) {
            CentyConfirmDialog(
                title = "Выход из учетной записи",
                message = "Вы уверены, что хотите завершить сеанс в приложении CentyChat?",
                confirmText = "Выйти",
                dismissText = "Отмена",
                isDestructive = true,
                onConfirm = {
                    showLogoutDialog = false
                    viewModel.logout(onLoggedOut)
                },
                onDismiss = { showLogoutDialog = false }
            )
        }
    }
}

@Composable
fun StatusChip(
    label: String,
    color: Color,
    isSelected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = if (isSelected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
        modifier = modifier.clickable(onClick = onClick)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(color)
            )
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                text = label,
                fontSize = 11.sp,
                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                color = if (isSelected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold
        )
    }
}
