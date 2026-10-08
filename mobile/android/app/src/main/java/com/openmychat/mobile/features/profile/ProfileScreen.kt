package com.openmychat.mobile.features.profile

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.platform.testTag
import com.openmychat.mobile.data.realtime.Presence
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
import androidx.compose.ui.res.pluralStringResource
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
import com.openmychat.mobile.features.auth.typographicQuotes
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.components.CentyConfirmDialog
import com.openmychat.mobile.ui.components.InlineNotice
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import com.openmychat.mobile.ui.components.StatusDot
import com.openmychat.mobile.ui.components.CentyTonalButton
import com.openmychat.mobile.ui.components.centyFieldColors
import com.openmychat.mobile.ui.components.presenceLabel
import com.openmychat.mobile.ui.components.rememberHaptics
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentySpace
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.components.InsetDivider
import com.openmychat.mobile.ui.components.SectionHeader
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

@Composable
fun ProfileScreen(
    viewModel: ProfileViewModel,
    onLoggedOut: () -> Unit,
    onOpenBlockedUsers: () -> Unit = {},
    onDeleteAccount: () -> Unit = {}
) {
    val uiState by viewModel.uiState.collectAsState()
    val presence by viewModel.presence.collectAsState()
    val dnd by viewModel.dnd.collectAsState()
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
                .padding(bottom = CentySpace.xl),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Column(Modifier.widthIn(max = 600.dp).fillMaxWidth()) {
                ProfileHeader(user, status = if (dnd) UserStatus.DND else presence.status)

                if (storageError != null || logoutError != null) {
                    Spacer(Modifier.size(CentySpace.m))
                    InlineNotice(stringResource(R.string.profile_storage_error), modifier = Modifier.padding(horizontal = CentySpace.gutter))
                }

                SectionTitle(stringResource(R.string.profile_status_section))
                Group {
                    // Присутствие автоматическое, как на настольном клиенте: только для показа.
                    PresenceRow(presence)
                    InsetDivider(DotTextEdge)
                    DndRow(enabled = dnd, onChange = viewModel::setDnd)
                    InsetDivider(DotTextEdge)
                    Column(Modifier.padding(horizontal = CentySpace.gutter, vertical = CentySpace.m), verticalArrangement = Arrangement.spacedBy(CentySpace.m)) {
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
                                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = tokens.accentText)
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
                        user?.company?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.profile_company) to typographicQuotes(it) },
                        user?.departmentName?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.profile_department) to it },
                        user?.extension?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.profile_extension) to it },
                        user?.email?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.profile_email) to it },
                        user?.phone?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.profile_phone) to it }
                    )
                    rows.forEachIndexed { index, (label, value) ->
                        if (index > 0) InsetDivider(CentySpace.gutter)
                        InfoRow(label, value)
                    }
                }

                SectionTitle(stringResource(R.string.profile_wake_section))
                Group {
                    Column(Modifier.padding(horizontal = CentySpace.gutter, vertical = CentySpace.s), verticalArrangement = Arrangement.spacedBy(CentySpace.m)) {
                        Text(stringResource(R.string.profile_wake_hint), style = MaterialTheme.typography.bodyMedium, color = tokens.textSecondary)
                        // Stacked, so the field and the button stay usable at large font sizes.
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(
                                value = wakeTarget,
                                onValueChange = { value -> wakeTarget = value.filter { it.isDigit() } },
                                label = { Text(stringResource(R.string.profile_wake_target)) },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                shape = RoundedCornerShape(CentyRadius.control),
                                colors = fieldColors(),
                                modifier = Modifier.fillMaxWidth()
                            )
                            val cooldown = uiState.wakeCooldownSeconds
                            CentyTonalButton(
                                text = if (cooldown > 0) stringResource(R.string.profile_wake_wait, cooldown) else stringResource(R.string.profile_wake_send),
                                onClick = {
                                    wakeTarget.toLongOrNull()?.let {
                                        viewModel.sendWakeToColleague(it)
                                        haptics.confirm()
                                    }
                                },
                                enabled = cooldown == 0 && wakeTarget.isNotBlank(),
                                modifier = Modifier.align(Alignment.End)
                            )
                        }
                    }
                }

                SectionTitle(stringResource(R.string.profile_privacy_section))
                Group {
                    NavigationRow(
                        icon = Icons.Outlined.Block,
                        text = stringResource(R.string.profile_blocked_users),
                        onClick = onOpenBlockedUsers,
                        tag = "profile-blocked-users"
                    )
                }

                SectionTitle(stringResource(R.string.profile_app_section))
                Group {
                    InfoRow(stringResource(R.string.profile_server), BuildConfig.SERVER_URL.toHttpUrlOrNull()?.host ?: BuildConfig.SERVER_URL)
                    InsetDivider(CentySpace.gutter)
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = CentySpace.gutter),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        // The brand mark speaks here (brief: «О приложении»).
                        Image(painterResource(R.drawable.ic_brand_mark), contentDescription = null, modifier = Modifier.size(28.dp))
                        Spacer(Modifier.width(12.dp))
                        Text(stringResource(R.string.app_name), style = MaterialTheme.typography.bodyLarge, color = tokens.textStrong, modifier = Modifier.weight(1f))
                        Text(
                            stringResource(R.string.profile_version_value, BuildConfig.VERSION_NAME),
                            style = MaterialTheme.typography.labelMedium,
                            color = tokens.textDim
                        )
                    }
                }

                Spacer(Modifier.size(CentySpace.section))
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

                Group {
                    InsetDivider(IconTextEdge)
                    NavigationRow(
                        icon = Icons.Outlined.DeleteForever,
                        text = stringResource(R.string.profile_delete_account),
                        onClick = onDeleteAccount,
                        tag = "profile-delete-account",
                        danger = true
                    )
                }
                Text(
                    stringResource(R.string.profile_delete_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = tokens.textDim,
                    modifier = Modifier.padding(start = CentySpace.gutter, end = CentySpace.gutter, top = CentySpace.s)
                )
            }
        }
    }

    if (showLogoutDialog) {
        // Unsent messages are deleted by a sign-out: the dialog says how many first.
        val unsent by viewModel.unsentCount.collectAsState()
        val unsentKnown by viewModel.unsentKnown.collectAsState()
        val base = stringResource(R.string.profile_logout_message)
        val unsentLine = when {
            // Not read yet: «nothing unsent» would not be true (copy-ru.md signout.unsent_unknown).
            !unsentKnown -> stringResource(R.string.profile_logout_unsent_unknown)
            unsent > 0 -> pluralStringResource(R.plurals.profile_logout_unsent, unsent, unsent)
            else -> null
        }
        CentyConfirmDialog(
            title = stringResource(R.string.profile_logout_title),
            message = if (unsentLine != null) "$unsentLine\n\n$base" else base,
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
private fun ProfileHeader(user: User?, status: UserStatus) {
    val tokens = CentyTheme.tokens
    val name = user?.fullName ?: stringResource(R.string.profile_unknown_user)
    Row(Modifier.fillMaxWidth().padding(start = CentySpace.gutter, end = CentySpace.gutter, top = CentySpace.s), verticalAlignment = Alignment.CenterVertically) {
        CentyAvatar(name = name, avatarUrl = user?.avatarUrl, status = status, size = 64.dp)
        Spacer(Modifier.width(CentySpace.l))
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

/** «Сейчас: В сети» — автоматическое присутствие; вручную не меняется. */
@Composable
private fun PresenceRow(presence: Presence) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .semantics(mergeDescendants = true) {}
            .testTag("presence-now"),
        verticalAlignment = Alignment.Top
    ) {
        // On the title's line, not in the middle of a two-line row.
        StatusDot(presence.status, size = 10.dp, modifier = Modifier.padding(top = DotTop))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                stringResource(R.string.profile_presence_now, presenceLabel(presence.status)),
                style = MaterialTheme.typography.bodyLarge,
                color = tokens.textStrong
            )
            Text(
                stringResource(R.string.profile_presence_auto),
                style = MaterialTheme.typography.bodyMedium,
                color = tokens.textSecondary
            )
        }
    }
}

/** Единственный ручной статус — «Не беспокоить» (`set_dnd`), поверх присутствия. */
@Composable
private fun DndRow(enabled: Boolean, onChange: (Boolean) -> Unit) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .toggleable(value = enabled, role = Role.Switch, onValueChange = onChange)
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .testTag("dnd-switch"),
        verticalAlignment = Alignment.Top
    ) {
        StatusDot(UserStatus.DND, size = 10.dp, modifier = Modifier.padding(top = DotTop))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.status_dnd), style = MaterialTheme.typography.bodyLarge, color = tokens.textStrong)
            Text(stringResource(R.string.profile_dnd_hint), style = MaterialTheme.typography.bodyMedium, color = tokens.textSecondary)
        }
        Spacer(Modifier.width(12.dp))
        Switch(
            modifier = Modifier.align(Alignment.CenterVertically),
            checked = enabled,
            onCheckedChange = null,
            colors = SwitchDefaults.colors(
                checkedTrackColor = tokens.primary,
                checkedThumbColor = androidx.compose.ui.graphics.Color.White,
                uncheckedTrackColor = tokens.hover,
                uncheckedBorderColor = tokens.borderStrong,
                uncheckedThumbColor = tokens.textDim
            )
        )
    }
}

/** A row that opens another screen (or a destructive flow, in danger colours). */
@Composable
private fun NavigationRow(icon: ImageVector, text: String, onClick: () -> Unit, tag: String, danger: Boolean = false) {
    val tokens = CentyTheme.tokens
    val color = if (danger) tokens.dangerText else tokens.textStrong
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, contentDescription = null, tint = if (danger) tokens.dangerText else tokens.accentText)
        Spacer(Modifier.width(12.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, color = color, modifier = Modifier.weight(1f))
        if (!danger) Icon(Icons.Outlined.ChevronRight, contentDescription = null, tint = tokens.textDim)
    }
}

/** A section header of the native grouped list (polish pass, rule 8). */
@Composable
private fun SectionTitle(text: String) = SectionHeader(text)

/**
 * The rows of one section, borderless on the list plane with inset hairlines between them
 * (polish pass, rules 1 and 8; Android settings style rather than iOS inset cards).
 */
@Composable
private fun Group(content: @Composable ColumnScope.() -> Unit) {
    Column(modifier = Modifier.fillMaxWidth(), content = content)
}

/** Puts a 10 dp dot on the centre of a bodyLarge first line (23 sp line). */
private val DotTop = 7.dp

/** Where the text of a row with a 10 dp status dot starts. */
private val DotTextEdge = CentySpace.gutter + 10.dp + CentySpace.rowGap

/** Where the text of a row with a 24 dp icon starts. */
private val IconTextEdge = CentySpace.gutter + 24.dp + CentySpace.rowGap

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
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1f)
        )
    }
}

@Composable
private fun fieldColors() = centyFieldColors()
