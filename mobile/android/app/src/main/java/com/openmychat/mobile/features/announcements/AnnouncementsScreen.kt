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
import com.openmychat.mobile.ui.components.PriorityMarker
import com.openmychat.mobile.ui.components.SectionHeader
import com.openmychat.mobile.ui.theme.CentySpace
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.text.font.FontWeight
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

/** The list's two sections, in the server's order inside each. */
internal object AnnouncementSections {
    enum class Kind(val title: Int) {
        NEEDS_ACK(R.string.announcements_section_new),
        READ(R.string.announcements_section_read)
    }

    data class Section(val kind: Kind, val items: List<Announcement>)

    fun of(all: List<Announcement>): List<Section> {
        val (read, open) = all.partition { it.isConfirmed }
        return listOfNotNull(
            open.takeIf { it.isNotEmpty() }?.let { Section(Kind.NEEDS_ACK, it) },
            read.takeIf { it.isNotEmpty() }?.let { Section(Kind.READ, it) }
        )
    }
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
                            // A native grouped list (polish pass, rule 8): what still needs «Ознакомлен»
                            // first, then the rest, each under a titleSmall header; borderless rows.
                            val sections = remember(uiState.announcements) { AnnouncementSections.of(uiState.announcements) }
                            val placement = if (reduce) null else androidx.compose.animation.core.tween<androidx.compose.ui.unit.IntOffset>(CentyMotion.BASE, easing = CentyMotion.EaseOut)
                            LazyColumn(
                                state = listState,
                                modifier = Modifier.fillMaxSize().testTag("announcement-list"),
                                contentPadding = PaddingValues(bottom = innerPadding.calculateBottomPadding() + CentySpace.l)
                            ) {
                                sections.forEachIndexed { sectionIndex, section ->
                                    item(key = "header-${section.kind}", contentType = "header") {
                                        SectionHeader(
                                            stringResource(section.kind.title),
                                            first = sectionIndex == 0,
                                            modifier = Modifier.animateItem(placementSpec = placement)
                                        )
                                    }
                                    itemsIndexed(section.items, key = { _, it -> it.id }, contentType = { _, _ -> "row" }) { index, item ->
                                        AnnouncementRow(
                                            item,
                                            divider = index < section.items.lastIndex,
                                            onClick = { actions.onOpen(item) },
                                            modifier = Modifier.animateItem(placementSpec = placement)
                                        )
                                    }
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

/**
 * One announcement as a list row, three type steps (polish pass, rule 3): the title in titleMedium
 * (600 while it still waits for «Ознакомлен», regular once read), two lines of text in bodyMedium
 * text-secondary, and the meta line in labelSmall text-dim — the importance dot with its label, the
 * author and the time.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AnnouncementRow(announcement: Announcement, divider: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    val state = stringResource(if (announcement.isConfirmed) R.string.announcements_acknowledged else R.string.announcements_needs_ack)
    val hairline = tokens.border
    Column(
        modifier = modifier
            .fillMaxWidth()
            .drawBehind {
                if (divider) {
                    val y = size.height - 0.5.dp.toPx()
                    drawLine(hairline, Offset(CentySpace.gutter.toPx(), y), Offset(size.width, y), strokeWidth = 1.dp.toPx())
                }
            }
            .clickable(onClick = onClick, role = Role.Button)
            .semantics(mergeDescendants = true) { stateDescription = state }
            .padding(horizontal = CentySpace.gutter, vertical = CentySpace.m)
            .testTag("announcement-row")
    ) {
        Text(
            announcement.title,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = if (announcement.isConfirmed) FontWeight.Normal else FontWeight.SemiBold,
            color = tokens.textStrong,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
        Spacer(Modifier.size(CentySpace.xs))
        Text(
            announcement.content,
            style = MaterialTheme.typography.bodyMedium,
            color = tokens.textSecondary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
        Spacer(Modifier.size(CentySpace.s))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(CentySpace.s),
            itemVerticalAlignment = Alignment.CenterVertically
        ) {
            PriorityMarker(announcement.priority)
            Text(
                stringResource(R.string.announcements_author, announcement.authorName, DateTimeUtils.formatDateTime(announcement.createdAt)),
                style = MaterialTheme.typography.labelSmall,
                color = tokens.textDim
            )
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
                PriorityMarker(announcement.priority, style = MaterialTheme.typography.labelMedium)
                Spacer(Modifier.size(CentySpace.m))
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
