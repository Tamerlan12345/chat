package com.openmychat.mobile.features.conversations

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import com.openmychat.mobile.features.people.Person
import com.openmychat.mobile.features.search.MessageHit
import com.openmychat.mobile.features.search.MessageResults
import com.openmychat.mobile.features.search.RecentItem
import com.openmychat.mobile.features.search.SearchMode
import com.openmychat.mobile.features.search.UniversalSearchActions
import com.openmychat.mobile.features.search.UniversalSearchContent
import com.openmychat.mobile.features.search.UniversalSearchState
import com.openmychat.mobile.features.search.UniversalSearchViewModel
import com.openmychat.mobile.ui.components.CentySearchField
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ripple
import androidx.compose.runtime.derivedStateOf
import androidx.compose.ui.graphics.Color
import com.openmychat.mobile.ui.components.Illustration
import com.openmychat.mobile.ui.components.SharedKeys
import com.openmychat.mobile.ui.components.liftSurface
import com.openmychat.mobile.ui.components.rememberLift
import com.openmychat.mobile.ui.components.sharedConversationElement
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
import androidx.compose.material.icons.outlined.Search
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
import androidx.compose.animation.core.tween
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.LocalReduceMotion
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
    searchViewModel: UniversalSearchViewModel,
    onOpenDirectChat: (userId: Long, name: String, avatarUrl: String?, status: String?) -> Unit,
    onOpenChannel: (channelId: Long, name: String) -> Unit,
    onOpenPerson: (Person) -> Unit = {},
    onOpenMessage: (MessageHit) -> Unit = {},
    onShowAllPeople: () -> Unit = {}
) {
    val selectedTab by viewModel.selectedTab.collectAsState()
    val search by searchViewModel.state.collectAsState()
    // Поиск — своё состояние экрана, не фильтр поверх списка (спецификация «Universal search»).
    var searchFocused by rememberSaveable { mutableStateOf(false) }
    // Одно правило для поля и выдачи: есть текст или фокус — показываем поиск.
    val searchActive = SearchMode.isActive(searchFocused, search.query)
    LaunchedEffect(searchActive) { if (searchActive) searchViewModel.onOpened() }
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

    val searchActions = remember(searchViewModel) {
        object : UniversalSearchActions {
            override fun onOpenPerson(match: Person) {
                searchViewModel.rememberPerson(match)
                onOpenPerson(match)
            }
            override fun onOpenChannel(channel: Channel) {
                searchViewModel.rememberChannel(channel)
                onOpenChannel(channel.id, channel.name)
            }
            override fun onOpenRecent(item: RecentItem) {
                searchViewModel.remember(item)
                when (item.kind) {
                    RecentItem.Kind.PERSON -> onOpenPerson(Person(id = item.id, fullName = item.title, avatarUrl = item.avatarUrl))
                    RecentItem.Kind.CHANNEL -> onOpenChannel(item.id, item.title)
                }
            }
            override fun onShowAllPeople(query: String) {
                searchViewModel.showAllPeople(query)
                onShowAllPeople()
            }
            override fun onOpenMessage(hit: MessageHit) = onOpenMessage(hit)
            override fun onClear() = searchViewModel.clear()
        }
    }

    val actions = remember(viewModel) {
        object : ConversationsActions {
            override fun onSelectTab(tab: ConversationsTab) = viewModel.selectTab(tab)
            override fun onSearch(query: String) = searchViewModel.setQuery(query)
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
        searchQuery = search.query,
        searchActive = searchActive,
        onSearchActiveChange = { active ->
            searchFocused = active
            if (!active) searchViewModel.clear()
        },
        search = search,
        searchActions = searchActions,
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
    currentUserId: Long? = null,
    searchActive: Boolean = false,
    onSearchActiveChange: (Boolean) -> Unit = {},
    search: UniversalSearchState = UniversalSearchState(query = searchQuery),
    searchActions: UniversalSearchActions = object : UniversalSearchActions {}
) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val focus = LocalFocusManager.current
    BackHandler(enabled = searchActive) {
        onSearchActiveChange(false)
        focus.clearFocus()
    }
    val collapse = if (reduce) tween<Float>(CentyMotion.REDUCED_CROSSFADE) else tween(200, easing = CentyMotion.EaseOut)
    val directState = rememberLazyListState()
    val channelState = rememberLazyListState()
    val listState = if (selectedTab == ConversationsTab.CHATS) directState else channelState
    // The header (bar, banner, search, segments) is flat on the list plane until rows pass under it.
    val scrolledUnder by remember(listState) { derivedStateOf { listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 0 } }
    val lift = rememberLift(scrolledUnder)
    Scaffold(
        modifier = modifier,
        containerColor = tokens.list,
        topBar = {
            Column(Modifier.liftSurface(lift, rest = tokens.list)) {
                TopAppBar(
                    title = { Text(stringResource(R.string.inbox_title)) },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = Color.Transparent,
                        scrolledContainerColor = Color.Transparent,
                        titleContentColor = tokens.textStrong
                    )
                )
                ConnectionBanner(connectionState)
                CentySearchField(
                    query = searchQuery,
                    onQueryChange = actions::onSearch,
                    placeholder = stringResource(R.string.search_hint),
                    active = searchActive,
                    onActiveChange = { active ->
                        onSearchActiveChange(active)
                        if (!active) focus.clearFocus()
                    },
                    onSearch = { openFirstResult(search, searchActions) },
                    testTag = "inbox-search",
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
                )
                AnimatedVisibility(
                    visible = !searchActive,
                    enter = fadeIn(collapse) + expandVertically(tween(200)),
                    exit = fadeOut(collapse) + shrinkVertically(tween(200))
                ) {
                    Segments(selectedTab, uiState, actions::onSelectTab)
                }
            }
        }
    ) { innerPadding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(top = innerPadding.calculateTopPadding())
                .consumeWindowInsets(innerPadding)
        ) {

            val listPadding = PaddingValues(top = 4.dp, bottom = innerPadding.calculateBottomPadding() + 8.dp)
            AnimatedContent(
                targetState = searchActive,
                transitionSpec = {
                    fadeIn(tween(if (reduce) CentyMotion.REDUCED_CROSSFADE else 150)) togetherWith
                        fadeOut(tween(if (reduce) CentyMotion.REDUCED_CROSSFADE else 90))
                },
                label = "inbox-search"
            ) { searching ->
            if (searching) {
                UniversalSearchContent(state = search, actions = searchActions, contentPadding = listPadding)
            } else when (uiState) {
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
                                color = tokens.accentText,
                                containerColor = tokens.elevated,
                                modifier = Modifier.align(Alignment.TopCenter)
                            )
                        }
                    ) {
                        if (selectedTab == ConversationsTab.CHATS) {
                            DirectList(directState, uiState.directConversations, "", listPadding, typing, openConversation, currentUserId, actions)
                        } else {
                            ChannelList(channelState, uiState.channels, "", listPadding, typing, openConversation, actions)
                        }
                    }
                }
            }
            }
        }
    }
}

/** Return в поиске открывает первый результат: человека, затем канал, затем сообщение. */
private fun openFirstResult(state: UniversalSearchState, actions: UniversalSearchActions) {
    state.people.firstOrNull()?.let { return actions.onOpenPerson(it.person) }
    state.channels.firstOrNull()?.let { return actions.onOpenChannel(it.channel) }
    (state.messages as? MessageResults.Found)?.hits?.firstOrNull()?.let { actions.onOpenMessage(it) }
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
    state: LazyListState,
    all: List<DirectConversation>,
    query: String,
    padding: PaddingValues,
    typing: Set<ConversationRef>,
    open: ConversationRef?,
    currentUserId: Long?,
    actions: ConversationsActions
) {
    val list = remember(all, query) { filterByName(all, query) }
    val reduce = LocalReduceMotion.current
    when {
        list.isEmpty() && query.isNotBlank() -> EmptyState(
            illustration = Illustration.SEARCH,
            title = stringResource(R.string.inbox_no_results),
            message = stringResource(R.string.inbox_no_results_message)
        )
        list.isEmpty() -> EmptyState(
            illustration = Illustration.INBOX,
            title = stringResource(R.string.inbox_empty_direct),
            message = stringResource(R.string.inbox_empty_direct_message),
            actionLabel = stringResource(R.string.action_refresh),
            onAction = actions::onRefresh
        )
        else -> LazyColumn(Modifier.fillMaxSize().testTag("conversation-list"), state = state, contentPadding = padding) {
            items(list, key = { "d-${it.userId}" }) { conversation ->
                val ref = ConversationRef(ConversationType.DIRECT, conversation.userId)
                DirectRow(
                    conversation = conversation,
                    isTyping = ref in typing,
                    isSelected = ref == open,
                    currentUserId = currentUserId,
                    onClick = { actions.onOpenDirect(conversation) },
                    modifier = Modifier.animateItem(placementSpec = if (reduce) null else tween(CentyMotion.BASE, easing = CentyMotion.EaseOut))
                )
            }
        }
    }
}

@Composable
private fun ChannelList(
    state: LazyListState,
    all: List<Channel>,
    query: String,
    padding: PaddingValues,
    typing: Set<ConversationRef>,
    open: ConversationRef?,
    actions: ConversationsActions
) {
    val list = remember(all, query) { filterChannelsByName(all, query) }
    val reduce = LocalReduceMotion.current
    when {
        list.isEmpty() && query.isNotBlank() -> EmptyState(
            illustration = Illustration.SEARCH,
            title = stringResource(R.string.inbox_no_results),
            message = stringResource(R.string.inbox_no_results_message)
        )
        list.isEmpty() -> EmptyState(
            illustration = Illustration.CHANNELS,
            title = stringResource(R.string.inbox_empty_channels),
            message = stringResource(R.string.inbox_empty_channels_message)
        )
        else -> LazyColumn(Modifier.fillMaxSize().testTag("conversation-list"), state = state, contentPadding = padding) {
            items(list, key = { "c-${it.id}" }) { channel ->
                val ref = ConversationRef(ConversationType.CHANNEL, channel.id)
                ChannelRow(
                    channel = channel,
                    isTyping = ref in typing,
                    isSelected = ref == open,
                    onClick = { actions.onOpenChannel(channel) },
                    modifier = Modifier.animateItem(placementSpec = if (reduce) null else tween(CentyMotion.BASE, easing = CentyMotion.EaseOut))
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
    val shared = SharedKeys.conversation(isChannel = false, id = conversation.userId)
    ConversationRow(
        title = conversation.fullName,
        sharedKey = shared,
        preview = preview,
        time = DateTimeUtils.formatTime(conversation.lastMessageTime),
        unread = conversation.unreadCount,
        isTyping = isTyping,
        isSelected = isSelected,
        onClick = onClick,
        modifier = modifier,
        avatar = { ring ->
            CentyAvatar(
                conversation.fullName,
                avatarUrl = conversation.avatarUrl,
                status = conversation.status,
                size = 44.dp,
                ringColor = ring,
                typing = isTyping,
                modifier = Modifier.sharedConversationElement(SharedKeys.avatar(shared))
            )
        }
    )
}

@Composable
private fun ChannelRow(channel: Channel, isTyping: Boolean, isSelected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val preview = channel.lastMessageText?.takeIf { it.isNotBlank() }
        ?: channel.topic?.takeIf { it.isNotBlank() }
        ?: pluralStringResource(R.plurals.channel_members, channel.membersCount, channel.membersCount)
    val shared = SharedKeys.conversation(isChannel = true, id = channel.id)
    ConversationRow(
        title = channel.name,
        sharedKey = shared,
        preview = preview,
        time = DateTimeUtils.formatTime(channel.lastMessageTime),
        unread = channel.unreadCount,
        isTyping = isTyping,
        isSelected = isSelected,
        onClick = onClick,
        modifier = modifier,
        avatar = { ring ->
            CentyAvatar(channel.name, size = 44.dp, isChannel = true, ringColor = ring, modifier = Modifier.sharedConversationElement(SharedKeys.avatar(shared)))
        }
    )
}

@Composable
private fun ConversationRow(
    title: String,
    sharedKey: String,
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
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    // Press: the ripple plus a 120 ms primary-soft highlight (brief), the tint of a selected row.
    val background by animateColorAsState(
        if (isSelected || pressed) tokens.primarySoft else Color.Transparent,
        CentyMotion.fast(),
        label = "row-press"
    )
    val unreadText = if (unread > 0) pluralStringResource(R.plurals.unread_messages, unread, unread) else null
    val typingText = stringResource(R.string.inbox_typing)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .background(background)
            .clickable(interactionSource = interaction, indication = ripple(), onClick = onClick, role = Role.Button)
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
                Box(Modifier.weight(1f)) {
                    Text(
                        title,
                        style = MaterialTheme.typography.titleMedium,
                        color = tokens.textStrong,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.sharedConversationElement(SharedKeys.title(sharedKey))
                    )
                }
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
