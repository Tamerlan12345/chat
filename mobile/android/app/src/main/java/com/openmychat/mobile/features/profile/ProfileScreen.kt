package com.openmychat.mobile.features.profile

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.BuildConfig
import com.openmychat.mobile.R
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.components.CentyConfirmDialog
import com.openmychat.mobile.ui.components.InlineNotice
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import com.openmychat.mobile.ui.components.StatusDot
import com.openmychat.mobile.ui.components.presenceLabel
import com.openmychat.mobile.ui.components.rememberHaptics
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

@Composable
fun ProfileScreen(
    viewModel: ProfileViewModel,
    onLoggedOut: () -> Unit
) {
    val uiState by viewModel.uiState.collectAsState()
    val logoutError by viewModel.logoutError.collectAsState()
    val storageError by viewModel.storageError.collectAsState()
    val snackbar = LocalSnackbarHostState.current
    val haptics = rememberHaptics()
    val saved = stringResource(R.string.profile_status_saved)
    val failed = stringResource(R.string.profile_status_failed)
    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                ProfileEvent.StatusSaved -> snackbar.showSnackbar(saved)
                ProfileEvent.StatusSaveFailed -> {
                    haptics.reject()
                    snackbar.showSnackbar(failed)
                }
            }
        }
    }

    val user = (uiState as? ProfileUiState.Content)?.user
    var showLogoutDialog by rememberSaveable { mutableStateOf(false) }
    var wakeTarget by rememberSaveable { mutableStateOf("") }
    val tokens = CentyTheme.tokens

    Scaffold(
        containerColor = tokens.list,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.profile_title)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = tokens.list, titleContentColor = tokens.textStrong)
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .consumeWindowInsets(innerPadding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Column(Modifier.widthIn(max = 600.dp).fillMaxWidth()) {
                ProfileHeader(user)

                if (storageError != null || logoutError != null) {
                    Spacer(Modifier.size(12.dp))
                    InlineNotice(stringResource(R.string.profile_storage_error))
                }

                SectionTitle(stringResource(R.string.profile_status_section))
                Group {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf(UserStatus.ONLINE, UserStatus.AWAY, UserStatus.DND).forEach { status ->
                                val selected = user?.status == status
                                FilterChip(
                                    selected = selected,
                                    onClick = { viewModel.setStatus(status) },
                                    label = { Text(presenceLabel(status)) },
                                    leadingIcon = { StatusDot(status, size = 10.dp) },
                                    shape = RoundedCornerShape(CentyRadius.chip),
                                    colors = FilterChipDefaults.filterChipColors(
                                        containerColor = tokens.card,
                                        labelColor = tokens.textSecondary,
                                        selectedContainerColor = tokens.primarySoft,
                                        selectedLabelColor = tokens.accentText
                                    ),
                                    border = FilterChipDefaults.filterChipBorder(
                                        enabled = true,
                                        selected = selected,
                                        borderColor = tokens.borderStrong,
                                        selectedBorderColor = tokens.primaryLine
                                    ),
                                    modifier = Modifier.heightIn(min = 48.dp)
                                )
                            }
                        }
                        OutlinedTextField(
                            value = uiState.customStatusInput,
                            onValueChange = viewModel::updateCustomStatusInput,
                            label = { Text(stringResource(R.string.profile_custom_status)) },
                            placeholder = { Text(stringResource(R.string.profile_custom_status_hint)) },
                            singleLine = true,
                            shape = RoundedCornerShape(CentyRadius.control),
                            colors = fieldColors(),
                            modifier = Modifier.fillMaxWidth(),
                            trailingIcon = {
                                IconButton(onClick = viewModel::saveCustomStatus, enabled = !uiState.isSaving) {
                                    if (uiState.isSaving) {
                                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                    } else {
                                        Icon(Icons.Outlined.Check, contentDescription = stringResource(R.string.profile_save_status), tint = tokens.accentText)
                                    }
                                }
                            }
                        )
                    }
                }

                SectionTitle(stringResource(R.string.profile_account_section))
                Group {
                    val rows = listOfNotNull(
                        stringResource(R.string.profile_login) to (user?.username ?: "—"),
                        user?.company?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.profile_company) to it },
                        user?.departmentName?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.profile_department) to it },
                        user?.extension?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.profile_extension) to it },
                        user?.email?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.profile_email) to it },
                        user?.phone?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.profile_phone) to it }
                    )
                    rows.forEachIndexed { index, (label, value) ->
                        if (index > 0) HorizontalDivider(Modifier.padding(start = 16.dp), color = tokens.border)
                        InfoRow(label, value)
                    }
                }

                SectionTitle(stringResource(R.string.profile_wake_section))
                Group {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(stringResource(R.string.profile_wake_hint), style = MaterialTheme.typography.bodyMedium, color = tokens.textSecondary)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(
                                value = wakeTarget,
                                onValueChange = { value -> wakeTarget = value.filter { it.isDigit() } },
                                label = { Text(stringResource(R.string.profile_wake_target)) },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                shape = RoundedCornerShape(CentyRadius.control),
                                colors = fieldColors(),
                                modifier = Modifier.weight(1f)
                            )
                            val cooldown = uiState.wakeCooldownSeconds
                            Button(
                                onClick = {
                                    wakeTarget.toLongOrNull()?.let {
                                        viewModel.sendWakeToColleague(it)
                                        haptics.confirm()
                                    }
                                },
                                enabled = cooldown == 0 && wakeTarget.isNotBlank(),
                                shape = RoundedCornerShape(CentyRadius.control),
                                modifier = Modifier.heightIn(min = 56.dp)
                            ) {
                                Text(if (cooldown > 0) stringResource(R.string.profile_wake_wait, cooldown) else stringResource(R.string.profile_wake_send))
                            }
                        }
                    }
                }

                SectionTitle(stringResource(R.string.profile_app_section))
                Group {
                    InfoRow(stringResource(R.string.profile_server), BuildConfig.SERVER_URL.toHttpUrlOrNull()?.host ?: BuildConfig.SERVER_URL)
                    HorizontalDivider(Modifier.padding(start = 16.dp), color = tokens.border)
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 16.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        // The brand mark speaks here (brief: «О приложении»).
                        Image(painterResource(R.drawable.ic_brand_mark), contentDescription = null, modifier = Modifier.size(28.dp))
                        Spacer(Modifier.width(12.dp))
                        Text(stringResource(R.string.app_name), style = MaterialTheme.typography.bodyLarge, color = tokens.textStrong, modifier = Modifier.weight(1f))
                        Text(
                            "${stringResource(R.string.profile_version)} ${BuildConfig.VERSION_NAME}",
                            style = MaterialTheme.typography.labelMedium,
                            color = tokens.textDim
                        )
                    }
                }

                Spacer(Modifier.size(24.dp))
                Group {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .clickable(role = Role.Button) { showLogoutDialog = true }
                            .padding(horizontal = 16.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(Icons.AutoMirrored.Outlined.Logout, contentDescription = null, tint = tokens.dangerText)
                        Spacer(Modifier.width(12.dp))
                        Text(stringResource(R.string.profile_logout), style = MaterialTheme.typography.bodyLarge, color = tokens.dangerText)
                    }
                }
            }
        }
    }

    if (showLogoutDialog) {
        CentyConfirmDialog(
            title = stringResource(R.string.profile_logout_title),
            message = stringResource(R.string.profile_logout_message),
            confirmText = stringResource(R.string.profile_logout),
            isDestructive = true,
            onConfirm = {
                showLogoutDialog = false
                viewModel.logout(onLoggedOut)
            },
            onDismiss = { showLogoutDialog = false }
        )
    }
}

@Composable
private fun ProfileHeader(user: User?) {
    val tokens = CentyTheme.tokens
    val name = user?.fullName ?: stringResource(R.string.profile_unknown_user)
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        CentyAvatar(name = name, avatarUrl = user?.avatarUrl, status = user?.status, size = 64.dp)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(
                name,
                style = MaterialTheme.typography.titleLarge,
                color = tokens.textStrong,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.semantics { heading() }
            )
            val subtitle = listOfNotNull(user?.jobTitle?.takeIf { it.isNotBlank() }, user?.customStatus?.takeIf { it.isNotBlank() })
            subtitle.forEach {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = tokens.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = CentyTheme.tokens.textSecondary,
        modifier = Modifier
            .padding(start = 4.dp, top = 24.dp, bottom = 8.dp)
            .semantics { heading() }
    )
}

@Composable
private fun Group(content: @Composable ColumnScope.() -> Unit) {
    val tokens = CentyTheme.tokens
    val shape = RoundedCornerShape(CentyRadius.card)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(tokens.card)
            .border(1.dp, tokens.border, shape),
        content = content
    )
}

@Composable
private fun InfoRow(label: String, value: String) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = tokens.textSecondary)
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = tokens.textStrong,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1f)
        )
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    unfocusedBorderColor = MaterialTheme.colorScheme.outline,
    unfocusedContainerColor = CentyTheme.tokens.card,
    focusedContainerColor = CentyTheme.tokens.card
)
