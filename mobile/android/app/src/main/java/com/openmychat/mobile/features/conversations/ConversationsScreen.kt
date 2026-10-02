package com.openmychat.mobile.features.conversations

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmychat.mobile.core.util.DateTimeUtils
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.ui.components.CentyAvatar

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun ConversationsScreen(
    viewModel: ConversationsViewModel,
    onOpenDirectChat: (userId: Long, name: String, avatarUrl: String?, status: String?) -> Unit,
    onOpenChannel: (channelId: Long, name: String) -> Unit,
    onNavigateToAnnouncements: () -> Unit,
    onNavigateToProfile: () -> Unit
) {
    val selectedTab by viewModel.selectedTab.collectAsState()
    val searchQuery by viewModel.searchQuery.collectAsState()
    val uiState by viewModel.uiState.collectAsState()
    val content = uiState as? ConversationsUiState.Content
    val directConversations = content?.directConversations.orEmpty()
    val channels = content?.channels.orEmpty()
    var isSearchActive by remember { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme

    Scaffold(
        containerColor = colors.background,
        topBar = {
            TopAppBar(
                title = {
                    if (isSearchActive) {
                        OutlinedTextField(
                            value = searchQuery,
                            onValueChange = viewModel::setSearchQuery,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 52.dp),
                            singleLine = true,
                            placeholder = { Text("Поиск сообщений") }
                        )
                    } else {
                        Column {
                            Text(
                                text = "CentyChat",
                                style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.Bold,
                                color = colors.primary
                            )
                            Text(
                                text = "Сообщения",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.onSurfaceVariant
                            )
                        }
                    }
                },
                actions = {
                    IconButton(
                        onClick = {
                            isSearchActive = !isSearchActive
                            if (!isSearchActive) viewModel.setSearchQuery("")
                        }
                    ) {
                        Icon(
                            imageVector = if (isSearchActive) Icons.Default.Close else Icons.Default.Search,
                            contentDescription = if (isSearchActive) "Закрыть поиск" else "Поиск сообщений"
                        )
                    }
                    IconButton(onClick = viewModel::loadData) {
                        Icon(
                            imageVector = Icons.Default.Refresh,
                            contentDescription = "Обновить сообщения"
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = colors.surface,
                    titleContentColor = colors.onSurface,
                    actionIconContentColor = colors.onSurfaceVariant
                )
            )
        },
        bottomBar = {
            NavigationBar(containerColor = colors.surfaceVariant.copy(alpha = 0.7f)) {
                NavigationBarItem(
                    selected = true,
                    onClick = {},
                    icon = { Icon(Icons.Default.Chat, contentDescription = "Сообщения") },
                    label = { Text("Сообщения") },
                    colors = centyNavigationColors()
                )
                NavigationBarItem(
                    selected = false,
                    onClick = onNavigateToAnnouncements,
                    icon = { Icon(Icons.Default.Campaign, contentDescription = "Объявления") },
                    label = { Text("Объявления") },
                    colors = centyNavigationColors()
                )
                NavigationBarItem(
                    selected = false,
                    onClick = onNavigateToProfile,
                    icon = { Icon(Icons.Default.AccountCircle, contentDescription = "Профиль") },
                    label = { Text("Профиль") },
                    colors = centyNavigationColors()
                )
            }
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(colors.background)
                .padding(innerPadding)
                .consumeWindowInsets(innerPadding)
        ) {
            ConversationTabs(
                selectedTab = selectedTab,
                directCount = directConversations.size,
                channelCount = channels.size,
                onTabSelected = viewModel::selectTab
            )

            when {
                uiState is ConversationsUiState.Loading -> ConversationLoadingState()
                uiState is ConversationsUiState.Error -> ConversationErrorState(
                    message = (uiState as ConversationsUiState.Error).message,
                    onRetry = viewModel::loadData
                )
                selectedTab == ConversationsTab.CHATS -> {
                    val filtered = remember(directConversations, searchQuery) {
                        if (searchQuery.isBlank()) directConversations else directConversations.filter {
                            it.fullName.contains(searchQuery, ignoreCase = true) ||
                                (it.username?.contains(searchQuery, ignoreCase = true) == true) ||
                                (it.departmentName?.contains(searchQuery, ignoreCase = true) == true)
                        }
                    }
                    if (filtered.isEmpty()) {
                        ConversationEmptyState(
                            icon = Icons.Default.Chat,
                            title = if (searchQuery.isBlank()) "Пока нет личных сообщений" else "Ничего не найдено",
                            message = if (searchQuery.isBlank()) {
                                "Новые диалоги появятся здесь."
                            } else {
                                "Измените запрос и попробуйте ещё раз."
                            }
                        )
                    } else {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(vertical = 8.dp)
                        ) {
                            items(filtered, key = { it.userId }) { conversation ->
                                DirectConversationItem(
                                    conversation = conversation,
                                    onClick = {
                                        onOpenDirectChat(
                                            conversation.userId,
                                            conversation.fullName,
                                            conversation.avatarUrl,
                                            conversation.status.value
                                        )
                                    }
                                )
                                ConversationDivider()
                            }
                        }
                    }
                }
                else -> {
                    val filtered = remember(channels, searchQuery) {
                        if (searchQuery.isBlank()) channels else channels.filter {
                            it.name.contains(searchQuery, ignoreCase = true) ||
                                (it.topic?.contains(searchQuery, ignoreCase = true) == true)
                        }
                    }
                    if (filtered.isEmpty()) {
                        ConversationEmptyState(
                            icon = Icons.Default.Tag,
                            title = if (searchQuery.isBlank()) "Пока нет доступных каналов" else "Ничего не найдено",
                            message = if (searchQuery.isBlank()) {
                                "Новые каналы появятся здесь."
                            } else {
                                "Измените запрос и попробуйте ещё раз."
                            }
                        )
                    } else {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(vertical = 8.dp)
                        ) {
                            items(filtered, key = { it.id }) { channel ->
                                ChannelItem(channel = channel, onClick = { onOpenChannel(channel.id, channel.name) })
                                ConversationDivider()
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ConversationTabs(
    selectedTab: ConversationsTab,
    directCount: Int,
    channelCount: Int,
    onTabSelected: (ConversationsTab) -> Unit
) {
    val colors = MaterialTheme.colorScheme
    TabRow(
        selectedTabIndex = selectedTab.ordinal,
        containerColor = colors.surface,
        contentColor = colors.primary,
        divider = { HorizontalDivider(color = colors.outlineVariant.copy(alpha = 0.7f)) }
    ) {
        ConversationTab(
            selected = selectedTab == ConversationsTab.CHATS,
            label = "Личные",
            count = directCount,
            onClick = { onTabSelected(ConversationsTab.CHATS) }
        )
        ConversationTab(
            selected = selectedTab == ConversationsTab.CHANNELS,
            label = "Каналы",
            count = channelCount,
            onClick = { onTabSelected(ConversationsTab.CHANNELS) }
        )
    }
}

@Composable
private fun ConversationTab(selected: Boolean, label: String, count: Int, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Tab(
        selected = selected,
        onClick = onClick,
        selectedContentColor = colors.primary,
        unselectedContentColor = colors.onSurfaceVariant,
        text = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(6.dp))
                Box(
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(if (selected) colors.primaryContainer else colors.surfaceVariant)
                        .padding(horizontal = 7.dp, vertical = 2.dp)
                ) {
                    Text(
                        text = count.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (selected) colors.onPrimaryContainer else colors.onSurfaceVariant
                    )
                }
            }
        }
    )
}

@Composable
private fun ConversationDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(start = 80.dp, end = 20.dp),
        color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.65f)
    )
}

@Composable
private fun ConversationLoadingState() {
    val colors = MaterialTheme.colorScheme
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(
                modifier = Modifier.size(32.dp),
                strokeWidth = 3.dp,
                color = colors.primary
            )
            Spacer(Modifier.height(16.dp))
            Text(
                text = "Обновляем сообщения",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun ConversationErrorState(message: String, onRetry: () -> Unit) {
    ConversationStatePanel(
        icon = Icons.Default.Error,
        iconTint = MaterialTheme.colorScheme.error,
        iconBackground = MaterialTheme.colorScheme.errorContainer,
        title = "Не удалось загрузить сообщения",
        message = message.ifBlank { "Проверьте подключение к серверу и попробуйте ещё раз." },
        actionLabel = "Повторить",
        onAction = onRetry
    )
}

@Composable
private fun ConversationEmptyState(icon: ImageVector, title: String, message: String) {
    ConversationStatePanel(
        icon = icon,
        iconTint = MaterialTheme.colorScheme.primary,
        iconBackground = MaterialTheme.colorScheme.primaryContainer,
        title = title,
        message = message
    )
}

@Composable
private fun ConversationStatePanel(
    icon: ImageVector,
    iconTint: Color,
    iconBackground: Color,
    title: String,
    message: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null
) {
    val colors = MaterialTheme.colorScheme
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 36.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier.width(300.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Box(
                modifier = Modifier
                    .size(64.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(iconBackground),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = iconTint,
                    modifier = Modifier.size(30.dp)
                )
            }
            Spacer(Modifier.height(24.dp))
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = colors.onBackground,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = colors.onSurfaceVariant,
                textAlign = TextAlign.Center,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis
            )
            if (actionLabel != null && onAction != null) {
                Spacer(Modifier.height(24.dp))
                Button(onClick = onAction) { Text(actionLabel) }
            }
        }
    }
}

@Composable
private fun centyNavigationColors() = NavigationBarItemDefaults.colors(
    selectedIconColor = MaterialTheme.colorScheme.onPrimaryContainer,
    selectedTextColor = MaterialTheme.colorScheme.primary,
    indicatorColor = MaterialTheme.colorScheme.primaryContainer,
    unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
    unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant
)

@Composable
fun DirectConversationItem(conversation: DirectConversation, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        CentyAvatar(
            name = conversation.fullName,
            avatarUrl = conversation.avatarUrl,
            status = conversation.status,
            size = 48.dp
        )
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = conversation.fullName,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (!conversation.lastMessageTime.isNullOrBlank()) {
                    Text(
                        text = DateTimeUtils.formatTime(conversation.lastMessageTime),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.onSurfaceVariant
                    )
                }
            }
            Spacer(Modifier.height(3.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = conversation.lastMessageText
                        ?: conversation.jobTitle
                        ?: conversation.departmentName
                        ?: "Нет сообщений",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                UnreadBadge(conversation.unreadCount)
            }
        }
    }
}

@Composable
fun ChannelItem(channel: Channel, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(colors.secondaryContainer),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Default.Tag,
                contentDescription = null,
                tint = colors.onSecondaryContainer
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = channel.name,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (!channel.lastMessageTime.isNullOrBlank()) {
                    Text(
                        text = DateTimeUtils.formatTime(channel.lastMessageTime),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.onSurfaceVariant
                    )
                }
            }
            Spacer(Modifier.height(3.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = channel.lastMessageText
                        ?: channel.topic
                        ?: "\${channel.membersCount} участников",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                UnreadBadge(channel.unreadCount)
            }
        }
    }
}

@Composable
private fun UnreadBadge(count: Int) {
    if (count <= 0) return
    val colors = MaterialTheme.colorScheme
    Spacer(Modifier.width(8.dp))
    Box(
        modifier = Modifier
            .clip(CircleShape)
            .background(colors.primary)
            .padding(horizontal = 8.dp, vertical = 3.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = if (count > 99) "99+" else count.toString(),
            color = colors.onPrimary,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold
        )
    }
}