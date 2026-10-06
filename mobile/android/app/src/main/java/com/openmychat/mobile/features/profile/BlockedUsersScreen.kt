package com.openmychat.mobile.features.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.features.account.accountFailureText
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import com.openmychat.mobile.ui.components.CentyTonalButton
import com.openmychat.mobile.ui.components.EmptyState
import com.openmychat.mobile.ui.components.InlineNotice
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentySpace
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.components.InsetDivider
import com.openmychat.mobile.ui.components.textEdgeAfter

@Composable
fun BlockedUsersScreen(viewModel: BlockedUsersViewModel, onBack: () -> Unit) {
    val state by viewModel.state.collectAsState()
    BlockedUsersContent(state, onBack = onBack, onUnblock = viewModel::unblock, onRetry = viewModel::refresh)
    val snackbar = LocalSnackbarHostState.current
    val failure = state.actionFailure
    val failureText = failure?.let { accountFailureText(it, System.currentTimeMillis()) ?: stringResource(R.string.account_error_unavailable) }
    val title = stringResource(R.string.blocked_unblock_failed)
    LaunchedEffect(failure) {
        if (failureText != null) {
            snackbar.showSnackbar("$title. $failureText")
            viewModel.dismissFailure()
        }
    }
}

/** The block list: avatar, name and «Разблокировать» per person; an empty state when there is nobody. */
@Composable
fun BlockedUsersContent(
    state: BlockedUsersState,
    onBack: () -> Unit,
    onUnblock: (Long) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier
) {
    val tokens = CentyTheme.tokens
    Scaffold(
        modifier = modifier.testTag("blocked-users"),
        containerColor = tokens.list,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.blocked_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
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
                .verticalScroll(rememberScrollState())
                .padding(top = CentySpace.s, bottom = CentySpace.xl),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Column(Modifier.widthIn(max = 600.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(CentySpace.m)) {
                state.loadFailure?.let { failure ->
                    InlineNotice(
                        text = accountFailureText(failure, System.currentTimeMillis()) ?: stringResource(R.string.blocked_load_failed),
                        actionLabel = stringResource(R.string.action_retry),
                        onAction = onRetry,
                        modifier = Modifier.padding(horizontal = CentySpace.gutter)
                    )
                }
                if (state.blocked.isEmpty()) {
                    if (state.loaded) {
                        EmptyState(
                            icon = Icons.Outlined.Block,
                            title = stringResource(R.string.blocked_empty),
                            message = stringResource(R.string.blocked_empty_message),
                            modifier = Modifier.testTag("blocked-empty")
                        )
                    }
                } else {
                    BlockedList(state, onUnblock)
                    Text(
                        stringResource(R.string.blocked_footer),
                        style = MaterialTheme.typography.bodySmall,
                        color = tokens.textDim,
                        modifier = Modifier.padding(horizontal = CentySpace.gutter)
                    )
                }
            }
        }
    }
}

@Composable
private fun BlockedList(state: BlockedUsersState, onUnblock: (Long) -> Unit) {
    // Borderless rows on the list plane, a hairline from the text edge (polish pass, rule 1).
    Column(Modifier.fillMaxWidth()) {
        state.blocked.forEachIndexed { index, user ->
            if (index > 0) InsetDivider(textEdgeAfter(BlockedAvatar))
            BlockedRow(user, busy = user.id in state.busyIds, onUnblock = { onUnblock(user.id) })
        }
    }
}

@Composable
private fun BlockedRow(user: BlockedUser, busy: Boolean, onUnblock: () -> Unit) {
    val tokens = CentyTheme.tokens
    val name = user.name ?: stringResource(R.string.blocked_unknown_name)
    val unblockLabel = stringResource(R.string.blocked_unblock_person, name)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .padding(horizontal = CentySpace.gutter, vertical = CentySpace.s)
            .testTag("blocked-${user.id}"),
        verticalAlignment = Alignment.CenterVertically
    ) {
        CentyAvatar(name = name, size = BlockedAvatar, ringColor = tokens.list)
        Spacer(Modifier.width(CentySpace.rowGap))
        val nameText = @Composable { textModifier: Modifier ->
            Text(
                name,
                style = MaterialTheme.typography.titleMedium,
                color = tokens.textStrong,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = textModifier
            )
        }
        val button = @Composable {
            CentyTonalButton(
                text = stringResource(R.string.safety_unblock),
                onClick = onUnblock,
                enabled = !busy,
                loading = busy,
                modifier = Modifier
                    .semantics { contentDescription = unblockLabel }
                    .testTag("unblock-${user.id}")
            )
        }
        // At a large system font the button would squeeze the name into broken syllables: it goes
        // under the name instead.
        if (LocalDensity.current.fontScale >= STACK_FONT_SCALE) {
            Column(Modifier.weight(1f)) {
                nameText(Modifier)
                Spacer(Modifier.height(CentySpace.s))
                button()
            }
        } else {
            nameText(Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            button()
        }
    }
}

private const val STACK_FONT_SCALE = 1.5f

private val BlockedAvatar = 40.dp
