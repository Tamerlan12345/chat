package com.openmychat.mobile.features.conversations

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.PersonSearch
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.util.DateTimeUtils
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.data.realtime.ConversationRef
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.components.ConnectionBanner
import com.openmychat.mobile.ui.components.ConversationSkeleton
import com.openmychat.mobile.ui.components.EmptyState
import com.openmychat.mobile.ui.components.ErrorState
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import com.openmychat.mobile.ui.components.TypingIndicator
import com.openmychat.mobile.ui.components.UnreadPill
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme

interface ConversationsActions {
    fun onSelectTab(tab: ConversationsTab) {}
    fun onSearch(query: String) {}
    fun onRefresh() {}
    fun onRetry() {}
    fun onOpenDirect(conversation: DirectConversation) {}
    fun onOpenChannel(channel: Channel) {}
}

@Composable
fun ConversationsScreen(
    viewModel: ConversationsViewModel,
    onOpenDirectChat: (userId: Long, name: String, avatarUrl: String?, status: String?) -> Unit,
    onOpenChannel: (channelId: Long, name: String) -> Unit
) {
    val selectedTab by viewModel.selectedTab.collectAsState()
    val searchQuery by viewModel.searchQuery.collectAsState()
    val uiState by viewModel.uiState.collectAsState()
    val connection by viewModel.connectionState.collectAsState()
    val refreshing by viewModel.isRefreshing.collectAsState()
    val typing by viewModel.typing.collectAsState()
    val open by viewModel.openConversation.collectAsState()
    val snackbar = LocalSnackbarHostState.current
    val refreshFailed = stringResource(R.string.inbox_refresh_failed)

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                ConversationsEvent.RefreshFailed -> snackbar.showSnackbar(refreshFailed)
            }
        }
    }

    val actions = remember(viewModel) {
        object : ConversationsActions {
            override fun onSelectTab(tab: ConversationsTab) = viewModel.selectTab(tab)
            override fun onSearch(query: String) = viewModel.setSearchQuery(query)
            override fun onRefresh() = viewModel.refresh()
            override fun onRetry() = viewModel.loadData()
            override fun onOpenDirect(conversation: DirectConversation) =
                onOpenDirectChat(conversation.userId, conversation.fullName, conversation.avatarUrl, conversation.status.value)
            override fun onOpenChannel(channel: Channel) = onOpenChannel(channel.id, channel.name)
        }
    }

    ConversationsContent(
        uiState = uiState,
        selectedTab = selectedTab,
        searchQuery = searchQuery,
        connectionState = connection,
        isRefreshing = refreshing,
        typing = typing,
        openConversation = open,
        currentUserId = viewModel.currentUserId,
        actions = actions
    )
}

/**
 * The inbox, stateless: «Чаты» top bar, connection banner when the link is down, name search,
 * «Личные / Каналы», 72dp rows (avatar with presence, name, time, one-line preview, unread pill).
 */
@Composable
fun ConversationsContent(
    uiState: ConversationsUiState,
    selectedTab: ConversationsTab,
    searchQuery: String,
    connectionState: ConnectionState,
    actions: ConversationsActions,
    modifier: Modifier = Modifier,
    isRefreshing: Boolean = false,
    typing: Set<ConversationRef> = emptySet(),
    openConversation: ConversationRef? = null,
    currentUserId: Long? = null
) {
    val tokens = CentyTheme.tokens
    Scaffold(
        modifier = modifier,
        containerColor = tokens.list,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.inbox_title)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = tokens.list, titleContentColor = tokens.textStrong)
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
            SearchField(query = searchQuery, onQueryChange = actions::onSearch)
            Segments(selectedTab, uiState, actions::onSelectTab)
            HorizontalDivider(color = tokens.border)

            val listPadding = PaddingValues(top = 4.dp, bottom = innerPadding.calculateBottomPadding() + 8.dp)
            when (uiState) {
                is ConversationsUiState.Loading -> ConversationSkeleton(contentPadding = PaddingValues(top = 4.dp))
                is ConversationsUiState.Error -> ErrorState(title = stringResource(R.string.inbox_error), onRetry = actions::onRetry)
                is ConversationsUiState.Content -> {
                    val pullState = rememberPullToRefreshState()
                    PullToRefreshBox(
                        isRefreshing = isRefreshing,
                        onRefresh = actions::onRefresh,
                        state = pullState,
                        modifier = Modifier.fillMaxSize(),
                        indicator = {
                            PullToRefreshDefaults.Indicator(
                                state = pullState,
                                isRefreshing = isRefreshing,
                                color = tokens.primary,
                                containerColor = tokens.elevated,
                                modifier = Modifier.align(Alignment.TopCenter)
                            )
                        }
                    ) {
                        if (selectedTab == ConversationsTab.CHATS) {
                            DirectList(uiState.directConversations, searchQuery, listPadding, typing, openConversation, currentUserId, actions)
                        } else {
                            ChannelList(uiState.channels, searchQuery, listPadding, typing, openConversation, actions)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SearchField(query: String, onQueryChange: (String) -> Unit) {
    val tokens = CentyTheme.tokens
    val focus = LocalFocusManager.current
    val shape = RoundedCornerShape(CentyRadius.control)
    BasicTextField(
        value = query,
        onValueChange = onQueryChange,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = tokens.textMain),
        cursorBrush = SolidColor(tokens.primary),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .testTag("inbox-search"),
        decorationBox = { inner ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .background(tokens.card, shape)
                    .border(1.dp, tokens.border, shape)
                    .padding(start = 12.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(Icons.Outlined.Search, contentDescription = null, tint = tokens.textDim, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Box(Modifier.weight(1f).padding(vertical = 10.dp)) {
                    if (query.isEmpty()) {
                        Text(stringResource(R.string.inbox_search_hint), style = MaterialTheme.typography.bodyLarge, color = tokens.textDim)
                    }
                    inner()
                }
                if (query.isNotEmpty()) {
                    IconButton(onClick = { onQueryChange("") }) {
                        Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.inbox_search_clear), tint = tokens.textSecondary)
                    }
                }
            }
        }
    )
}

@Composable
private fun Segments(selected: ConversationsTab, uiState: ConversationsUiState, onSelect: (ConversationsTab) -> Unit) {
    val tokens = CentyTheme.tokens
    val content = uiState as? ConversationsUiState.Content
    val directUnread = content?.directConversations?.sumOf { it.unreadCount } ?: 0
    val channelUnread = content?.channels?.sumOf { it.unreadCount } ?: 0
    val colors = SegmentedButtonDefaults.colors(
        activeContainerColor = tokens.primarySoft,
        activeContentColor = tokens.accentText,
        activeBorderColor = tokens.primaryLine,
        inactiveContainerColor = tokens.card,
        inactiveContentColor = tokens.textSecondary,
        inactiveBorderColor = tokens.borderStrong
    )
    SingleChoiceSegmentedButtonRow(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
    ) {
        listOf(
            Triple(ConversationsTab.CHATS, R.string.inbox_segment_direct, directUnread),
            Triple(ConversationsTab.CHANNELS, R.string.inbox_segment_channels, channelUnread)
        ).forEachIndexed { index, (tab, label, unread) ->
            SegmentedButton(
                selected = selected == tab,
                onClick = { onSelect(tab) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = 2, baseShape = RoundedCornerShape(CentyRadius.control)),
                colors = colors,
                icon = {},
                label = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(stringResource(label), maxLines = 1)
                        UnreadPill(unread)
                    }
                }
            )
        }
    }
}

@Composable
private fun DirectList(
    all: List<DirectConversation>,
    query: String,
    padding: PaddingValues,
    typing: Set<ConversationRef>,
    open: ConversationRef?,
    currentUserId: Long?,
    actions: ConversationsActions
) {
    val list = remember(all, query) { filterByName(all, query) }
    when {
        list.isEmpty() && query.isNotBlank() -> EmptyState(
            icon = Icons.Outlined.PersonSearch,
            title = stringResource(R.string.inbox_no_results),
            message = stringResource(R.string.inbox_no_results_message)
        )
        list.isEmpty() -> EmptyState(
            icon = Icons.Outlined.Forum,
            title = stringResource(R.string.inbox_empty_direct),
            message = stringResource(R.string.inbox_empty_direct_message),
            actionLabel = stringResource(R.string.action_refresh),
            onAction = actions::onRefresh
        )
        else -> LazyColumn(Modifier.fillMaxSize().testTag("conversation-list"), contentPadding = padding) {
            items(list, key = { "d-${it.userId}" }) { conversation ->
                val ref = ConversationRef(ConversationType.DIRECT, conversation.userId)
                DirectRow(
                    conversation = conversation,
                    isTyping = ref in typing,
                    isSelected = ref == open,
                    currentUserId = currentUserId,
                    onClick = { actions.onOpenDirect(conversation) },
                    modifier = Modifier.animateItem()
                )
            }
        }
    }
}

@Composable
private fun ChannelList(
    all: List<Channel>,
    query: String,
    padding: PaddingValues,
    typing: Set<ConversationRef>,
    open: ConversationRef?,
    actions: ConversationsActions
) {
    val list = remember(all, query) { filterChannelsByName(all, query) }
    when {
        list.isEmpty() && query.isNotBlank() -> EmptyState(
            icon = Icons.Outlined.PersonSearch,
            title = stringResource(R.string.inbox_no_results),
            message = stringResource(R.string.inbox_no_results_message)
        )
        list.isEmpty() -> EmptyState(
            icon = Icons.Outlined.Tag,
            title = stringResource(R.string.inbox_empty_channels),
            message = stringResource(R.string.inbox_empty_channels_message)
        )
        else -> LazyColumn(Modifier.fillMaxSize().testTag("conversation-list"), contentPadding = padding) {
            items(list, key = { "c-${it.id}" }) { channel ->
                val ref = ConversationRef(ConversationType.CHANNEL, channel.id)
                ChannelRow(
                    channel = channel,
                    isTyping = ref in typing,
                    isSelected = ref == open,
                    onClick = { actions.onOpenChannel(channel) },
                    modifier = Modifier.animateItem()
                )
            }
        }
    }
}

@Composable
private fun DirectRow(
    conversation: DirectConversation,
    isTyping: Boolean,
    isSelected: Boolean,
    currentUserId: Long?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val last = conversation.lastMessageText?.takeIf { it.isNotBlank() }
    val preview = when {
        last != null && conversation.lastMessageSenderId != null && conversation.lastMessageSenderId == currentUserId ->
            stringResource(R.string.inbox_preview_you, last)
        last != null -> last
        else -> conversation.jobTitle ?: conversation.departmentName ?: stringResource(R.string.inbox_preview_empty)
    }
    ConversationRow(
        title = conversation.fullName,
        preview = preview,
        time = DateTimeUtils.formatTime(conversation.lastMessageTime),
        unread = conversation.unreadCount,
        isTyping = isTyping,
        isSelected = isSelected,
        onClick = onClick,
        modifier = modifier,
        avatar = { ring ->
            CentyAvatar(conversation.fullName, avatarUrl = conversation.avatarUrl, status = conversation.status, size = 44.dp, ringColor = ring)
        }
    )
}

@Composable
private fun ChannelRow(channel: Channel, isTyping: Boolean, isSelected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val preview = channel.lastMessageText?.takeIf { it.isNotBlank() }
        ?: channel.topic?.takeIf { it.isNotBlank() }
        ?: pluralStringResource(R.plurals.channel_members, channel.membersCount, channel.membersCount)
    ConversationRow(
        title = channel.name,
        preview = preview,
        time = DateTimeUtils.formatTime(channel.lastMessageTime),
        unread = channel.unreadCount,
        isTyping = isTyping,
        isSelected = isSelected,
        onClick = onClick,
        modifier = modifier,
        avatar = { ring -> CentyAvatar(channel.name, size = 44.dp, isChannel = true, ringColor = ring) }
    )
}

@Composable
private fun ConversationRow(
    title: String,
    preview: String,
    time: String,
    unread: Int,
    isTyping: Boolean,
    isSelected: Boolean,
    onClick: () -> Unit,
    avatar: @Composable (ringColor: androidx.compose.ui.graphics.Color) -> Unit,
    modifier: Modifier = Modifier
) {
    val tokens = CentyTheme.tokens
    val background = if (isSelected) tokens.primarySoft else androidx.compose.ui.graphics.Color.Transparent
    val unreadText = if (unread > 0) pluralStringResource(R.plurals.unread_messages, unread, unread) else null
    val typingText = stringResource(R.string.inbox_typing)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .background(background)
            .clickable(onClick = onClick, role = Role.Button)
            .semantics(mergeDescendants = true) {
                if (unreadText != null) stateDescription = unreadText
            }
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // The presence dot is cut out of whatever is behind the row.
        avatar(if (isSelected) tokens.primarySoft.compositeOver(tokens.list) else tokens.list)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleMedium,
                    color = tokens.textStrong,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (time.isNotEmpty()) {
                    Spacer(Modifier.width(8.dp))
                    Text(time, style = MaterialTheme.typography.labelSmall, color = if (unread > 0) tokens.accentText else tokens.textDim)
                }
            }
            Spacer(Modifier.size(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    if (isTyping) {
                        TypingIndicator(typingText)
                    } else {
                        Text(
                            preview,
                            style = MaterialTheme.typography.bodyMedium,
                            color = tokens.textSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
                Spacer(Modifier.width(8.dp))
                UnreadPill(unread)
            }
        }
    }
}
