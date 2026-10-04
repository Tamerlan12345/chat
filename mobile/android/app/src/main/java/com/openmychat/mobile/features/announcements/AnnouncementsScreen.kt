package com.openmychat.mobile.features.announcements

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import com.openmychat.mobile.ui.components.AcknowledgeButton
import com.openmychat.mobile.ui.components.Illustration
import com.openmychat.mobile.ui.components.liftSurface
import com.openmychat.mobile.ui.components.rememberLift
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.util.DateTimeUtils
import com.openmychat.mobile.data.model.Announcement
import com.openmychat.mobile.ui.components.CardSkeleton
import com.openmychat.mobile.ui.components.ConnectionBanner
import com.openmychat.mobile.ui.components.EmptyState
import com.openmychat.mobile.ui.components.ErrorState
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import com.openmychat.mobile.ui.components.PriorityBadge
import com.openmychat.mobile.ui.components.rememberHaptics
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion

interface AnnouncementsActions {
    fun onRefresh() {}
    fun onOpen(announcement: Announcement?) {}
    fun onAcknowledge() {}
}

@Composable
fun AnnouncementsScreen(viewModel: AnnouncementsViewModel) {
    val uiState by viewModel.uiState.collectAsState()
    val connection by viewModel.connectionState.collectAsState()
    val snackbar = LocalSnackbarHostState.current
    val haptics = rememberHaptics()
    val refreshFailed = stringResource(R.string.announcements_refresh_failed)
    val ackFailed = stringResource(R.string.announcements_ack_failed)

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                AnnouncementsEvent.Acknowledged -> haptics.confirm()
                AnnouncementsEvent.AcknowledgeFailed -> {
                    haptics.reject()
                    snackbar.showSnackbar(ackFailed)
                }
                AnnouncementsEvent.RefreshFailed -> snackbar.showSnackbar(refreshFailed)
            }
        }
    }
    val actions = remember(viewModel) {
        object : AnnouncementsActions {
            override fun onRefresh() = viewModel.loadAnnouncements()
            override fun onOpen(announcement: Announcement?) = viewModel.selectAnnouncement(announcement)
            override fun onAcknowledge() = viewModel.acknowledgeSelected()
        }
    }
    AnnouncementsContent(uiState, connection, actions)
}

@Composable
fun AnnouncementsContent(
    uiState: AnnouncementsUiState,
    connectionState: ConnectionState,
    actions: AnnouncementsActions,
    modifier: Modifier = Modifier
) {
    val tokens = CentyTheme.tokens
    val listState = rememberLazyListState()
    val scrolledUnder by remember { derivedStateOf { listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 0 } }
    val lift = rememberLift(scrolledUnder)
    Scaffold(
        modifier = modifier,
        containerColor = tokens.list,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.announcements_title)) },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    scrolledContainerColor = Color.Transparent,
                    titleContentColor = tokens.textStrong
                ),
                modifier = Modifier.liftSurface(lift, rest = tokens.list)
            )
        }
    ) { innerPadding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(top = innerPadding.calculateTopPadding())
                .consumeWindowInsets(innerPadding)
        ) {
            ConnectionBanner(connectionState)
            when (uiState) {
                is AnnouncementsUiState.Loading -> CardSkeleton()
                is AnnouncementsUiState.Error -> ErrorState(stringResource(R.string.announcements_error), onRetry = actions::onRefresh)
                is AnnouncementsUiState.Content -> {
                    val pullState = rememberPullToRefreshState()
                    PullToRefreshBox(
                        isRefreshing = uiState.isRefreshing,
                        onRefresh = actions::onRefresh,
                        state = pullState,
                        modifier = Modifier.fillMaxSize(),
                        indicator = {
                            PullToRefreshDefaults.Indicator(
                                state = pullState,
                                isRefreshing = uiState.isRefreshing,
                                color = tokens.accentText,
                                containerColor = tokens.elevated,
                                modifier = Modifier.align(Alignment.TopCenter)
                            )
                        }
                    ) {
                        if (uiState.announcements.isEmpty()) {
                            EmptyState(
                                illustration = Illustration.ANNOUNCEMENTS,
                                title = stringResource(R.string.announcements_empty),
                                message = stringResource(R.string.announcements_empty_message)
                            )
                        } else {
                            val reduce = LocalReduceMotion.current
                            LazyColumn(
                                state = listState,
                                modifier = Modifier.fillMaxSize().testTag("announcement-list"),
                                contentPadding = PaddingValues(
                                    start = 16.dp, end = 16.dp, top = 8.dp,
                                    bottom = innerPadding.calculateBottomPadding() + 16.dp
                                ),
                                verticalArrangement = Arrangement.spacedBy(10.dp)
                            ) {
                                items(uiState.announcements, key = { it.id }) { item ->
                                    AnnouncementCard(
                                        item,
                                        onClick = { actions.onOpen(item) },
                                        modifier = Modifier.animateItem(
                                            placementSpec = if (reduce) null else androidx.compose.animation.core.tween(CentyMotion.BASE, easing = CentyMotion.EaseOut)
                                        )
                                    )
                                }
                            }
                        }
                    }
                    uiState.selected?.let { selected ->
                        AnnouncementSheet(
                            announcement = selected,
                            isAcknowledging = uiState.isAcknowledging,
                            onAcknowledge = actions::onAcknowledge,
                            onDismiss = { actions.onOpen(null) }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun AnnouncementCard(announcement: Announcement, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    val shape = RoundedCornerShape(CentyRadius.card)
    val state = stringResource(if (announcement.isConfirmed) R.string.announcements_acknowledged else R.string.announcements_needs_ack)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(tokens.card, shape)
            .border(1.dp, tokens.border, shape)
            .clip(shape)
            .clickable(onClick = onClick, role = Role.Button)
            .semantics(mergeDescendants = true) { stateDescription = state }
            .padding(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            PriorityBadge(announcement.priority)
            Spacer(Modifier.weight(1f))
            AckState(announcement.isConfirmed)
        }
        Spacer(Modifier.size(10.dp))
        Text(
            announcement.title,
            style = MaterialTheme.typography.titleMedium,
            color = tokens.textStrong,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
        Spacer(Modifier.size(4.dp))
        Text(
            announcement.content,
            style = MaterialTheme.typography.bodyMedium,
            color = tokens.textSecondary,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis
        )
        Spacer(Modifier.size(10.dp))
        Text(
            stringResource(R.string.announcements_author, announcement.authorName, DateTimeUtils.formatDateTime(announcement.createdAt)),
            style = MaterialTheme.typography.labelSmall,
            color = tokens.textDim
        )
    }
}

@Composable
private fun AckState(confirmed: Boolean) {
    val tokens = CentyTheme.tokens
    if (confirmed) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(Icons.Rounded.CheckCircle, contentDescription = null, tint = tokens.success, modifier = Modifier.size(16.dp))
            Text(stringResource(R.string.announcements_acknowledged), style = MaterialTheme.typography.labelMedium, color = tokens.successText)
        }
    } else {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(8.dp).background(tokens.primary, CircleShape))
            Text(stringResource(R.string.announcements_needs_ack), style = MaterialTheme.typography.labelMedium, color = tokens.accentText)
        }
    }
}

@Composable
private fun AnnouncementSheet(
    announcement: Announcement,
    isAcknowledging: Boolean,
    onAcknowledge: () -> Unit,
    onDismiss: () -> Unit
) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = tokens.elevated,
        scrimColor = tokens.scrim,
        contentColor = tokens.textMain
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 24.dp)
                .padding(bottom = 16.dp)
        ) {
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                PriorityBadge(announcement.priority)
                Spacer(Modifier.size(12.dp))
                Text(
                    announcement.title,
                    style = MaterialTheme.typography.headlineSmall,
                    color = tokens.textStrong,
                    modifier = Modifier.semantics { heading() }
                )
                Spacer(Modifier.size(6.dp))
                Text(
                    listOfNotNull(announcement.authorName.takeIf { it.isNotBlank() }, announcement.authorJobTitle).joinToString(", "),
                    style = MaterialTheme.typography.labelMedium,
                    color = tokens.textSecondary
                )
                Text(
                    stringResource(R.string.announcements_published, DateTimeUtils.formatDateTime(announcement.createdAt)),
                    style = MaterialTheme.typography.labelMedium,
                    color = tokens.textDim
                )
                if (!announcement.expiresAt.isNullOrBlank()) {
                    Text(
                        stringResource(R.string.announcements_expires, DateTimeUtils.formatDateTime(announcement.expiresAt)),
                        style = MaterialTheme.typography.labelMedium,
                        color = tokens.textDim
                    )
                }
                HorizontalDivider(Modifier.padding(vertical = 16.dp), color = tokens.border)
                Text(announcement.content, style = MaterialTheme.typography.bodyLarge, color = tokens.textMain)
                Spacer(Modifier.size(20.dp))
            }
            // «Ознакомлен» turns into its success state in place; the check draws in (the stamp).
            AcknowledgeButton(
                acknowledged = announcement.isConfirmed,
                busy = isAcknowledging,
                onAcknowledge = onAcknowledge
            )
        }
    }
}
