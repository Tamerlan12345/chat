package com.openmychat.mobile.features.chat

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.openmychat.mobile.core.util.DateTimeUtils
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DeliveryStatus
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.theme.CentyTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    viewModel: ChatViewModel,
    title: String,
    avatarUrl: String? = null,
    status: String? = null,
    showBackButton: Boolean = true,
    onNavigateBack: () -> Unit,
    onStartCall: (peerId: Long, peerName: String) -> Unit
) {
    val uiState by viewModel.uiState.collectAsState()
    val messages = (uiState as? ChatUiState.Content)?.messages.orEmpty()
    val typingUser by viewModel.typingUser.collectAsState()
    val wakeCooldown by viewModel.wakeCooldownSeconds.collectAsState()
    val editingMessage by viewModel.editingMessage.collectAsState()

    // Nav3 gives each entry its own lifecycle: the chat counts as open only while it is resumed,
    // not while it waits in the back stack under a call or behind another tab.
    LifecycleResumeEffect(viewModel) {
        viewModel.onVisibilityChanged(true)
        onPauseOrDispose { viewModel.onVisibilityChanged(false) }
    }

    var inputText by remember { mutableStateOf("") }
    val listState = rememberLazyListState()

    // Sync input text when editing message changes
    LaunchedEffect(editingMessage) {
        if (editingMessage != null) {
            inputText = editingMessage?.text ?: ""
        }
    }

    // Scroll to bottom when messages count changes
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.lastIndex)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CentyAvatar(
                            name = title,
                            avatarUrl = avatarUrl,
                            status = if (viewModel.conversationType == ConversationType.DIRECT) UserStatus.fromValue(status) else null,
                            size = 36.dp
                        )
                        Spacer(modifier = Modifier.width(10.dp))
                        Column {
                            Text(
                                text = title,
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            if (viewModel.conversationType == ConversationType.DIRECT && !status.isNullOrBlank()) {
                                Text(
                                    text = status.replaceFirstChar { it.uppercase() },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                },
                navigationIcon = {
                    if (showBackButton) {
                        IconButton(onClick = onNavigateBack) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = "Назад"
                            )
                        }
                    }
                },
                actions = {
                    if (viewModel.conversationType == ConversationType.DIRECT) {
                        // Wake Buzzer button
                        IconButton(
                            onClick = { viewModel.sendWake() },
                            enabled = wakeCooldown == 0
                        ) {
                            if (wakeCooldown > 0) {
                                Box(contentAlignment = Alignment.Center) {
                                    Text(
                                        text = "${wakeCooldown}s",
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = MaterialTheme.colorScheme.primary
                                    )
                                }
                            } else {
                                Icon(
                                    imageVector = Icons.Default.NotificationsActive,
                                    contentDescription = "Побудка",
                                    tint = MaterialTheme.colorScheme.primary
                                )
                            }
                        }

                        // Call button
                        IconButton(onClick = { onStartCall(viewModel.targetId, title) }) {
                            Icon(
                                imageVector = Icons.Default.Call,
                                contentDescription = "Позвонить",
                                tint = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                },
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
        ) {
            // Message List
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
            ) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    items(messages, key = { it.id }) { message ->
                        val isOwn = message.senderId == viewModel.currentUserId
                        MessageBubble(
                            message = message,
                            isOwn = isOwn,
                            canEdit = viewModel.canEditMessage(message),
                            canDelete = viewModel.canDeleteMessage(message),
                            onEdit = { viewModel.startEditing(message) },
                            onDelete = { viewModel.deleteMessage(message) }
                        )
                    }
                }
                when (val state = uiState) {
                    is ChatUiState.Loading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                    is ChatUiState.Error -> Column(
                        modifier = Modifier
                            .align(Alignment.Center)
                            .padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text(
                            text = state.message,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.height(12.dp))
                        Button(onClick = { viewModel.loadMessages() }) { Text("Повторить") }
                    }
                    is ChatUiState.Content -> Unit
                }
            }

            // Typing indicator
            if (typingUser != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "$typingUser печатает…",
                        style = MaterialTheme.typography.bodySmall,
                        fontStyle = FontStyle.Italic,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
            }

            // Edit banner if in edit mode
            if (editingMessage != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(horizontal = 16.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                        Icon(
                            imageVector = Icons.Default.Edit,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Редактирование сообщения",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                    IconButton(
                        onClick = {
                            viewModel.cancelEditing()
                            inputText = ""
                        },
                        modifier = Modifier.size(24.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Отмена"
                        )
                    }
                }
            }

            // Bottom Input Bar with imePadding for soft keyboard
            Surface(
                tonalElevation = 2.dp,
                modifier = Modifier
                    .fillMaxWidth()
                    .imePadding()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OutlinedTextField(
                        value = inputText,
                        onValueChange = {
                            inputText = it
                            viewModel.onTyping(it.isNotBlank())
                        },
                        placeholder = { Text("Сообщение…") },
                        maxLines = 4,
                        modifier = Modifier
                            .weight(1f)
                            .padding(end = 8.dp),
                        shape = RoundedCornerShape(24.dp)
                    )

                    FloatingActionButton(
                        onClick = {
                            if (inputText.isNotBlank()) {
                                viewModel.sendMessage(inputText)
                                inputText = ""
                                viewModel.onTyping(false)
                            }
                        },
                        shape = CircleShape,
                        modifier = Modifier.size(48.dp),
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary
                    ) {
                        Icon(
                            imageVector = if (editingMessage != null) Icons.Default.Check else Icons.AutoMirrored.Filled.Send,
                            contentDescription = "Отправить",
                            modifier = Modifier.size(20.dp)
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessageBubble(
    message: Message,
    isOwn: Boolean,
    canEdit: Boolean,
    canDelete: Boolean,
    onEdit: () -> Unit,
    onDelete: () -> Unit
) {
    var menuExpanded by remember { mutableStateOf(false) }
    val clipboardManager = LocalClipboardManager.current
    // Bubble colours come from theme tokens, never from guessing the theme by a colour channel.
    val tokens = CentyTheme.tokens
    val bubbleColor = if (isOwn) tokens.primarySoft else tokens.card

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        contentAlignment = if (isOwn) Alignment.CenterEnd else Alignment.CenterStart
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .clip(
                    RoundedCornerShape(
                        topStart = 16.dp,
                        topEnd = 16.dp,
                        bottomStart = if (isOwn) 16.dp else 4.dp,
                        bottomEnd = if (isOwn) 4.dp else 16.dp
                    )
                )
                .background(bubbleColor)
                .combinedClickable(
                    onClick = {},
                    onLongClick = { menuExpanded = true }
                )
                .padding(horizontal = 12.dp, vertical = 8.dp)
        ) {
            if (!isOwn && message.senderName.isNotBlank()) {
                Text(
                    text = message.senderName,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )
                Spacer(modifier = Modifier.height(2.dp))
            }

            Text(
                text = message.text,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface
            )

            Spacer(modifier = Modifier.height(4.dp))

            Row(
                modifier = Modifier.align(Alignment.End),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (!message.updatedAt.isNullOrBlank()) {
                    Text(
                        text = "ред.",
                        fontSize = 10.sp,
                        fontStyle = FontStyle.Italic,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                }

                Text(
                    text = DateTimeUtils.formatTime(message.createdAt),
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )

                if (isOwn) {
                    Spacer(modifier = Modifier.width(4.dp))
                    when (message.deliveryStatus) {
                        DeliveryStatus.READ -> {
                            Icon(
                                imageVector = Icons.Default.DoneAll,
                                contentDescription = "Прочитано",
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(14.dp)
                            )
                        }
                        DeliveryStatus.DELIVERED -> {
                            Icon(
                                imageVector = Icons.Default.Check,
                                contentDescription = "Доставлено",
                                tint = MaterialTheme.colorScheme.outline,
                                modifier = Modifier.size(14.dp)
                            )
                        }
                        null -> {
                            Icon(
                                imageVector = Icons.Default.Schedule,
                                contentDescription = "Отправка",
                                tint = MaterialTheme.colorScheme.outline,
                                modifier = Modifier.size(12.dp)
                            )
                        }
                    }
                }
            }

            DropdownMenu(
                expanded = menuExpanded,
                onDismissRequest = { menuExpanded = false }
            ) {
                DropdownMenuItem(
                    text = { Text("Копировать") },
                    onClick = {
                        clipboardManager.setText(AnnotatedString(message.text))
                        menuExpanded = false
                    },
                    leadingIcon = { Icon(Icons.Default.ContentCopy, contentDescription = null) }
                )

                if (canEdit) {
                    DropdownMenuItem(
                        text = { Text("Изменить") },
                        onClick = {
                            menuExpanded = false
                            onEdit()
                        },
                        leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) }
                    )
                }

                if (canDelete) {
                    DropdownMenuItem(
                        text = { Text("Удалить", color = MaterialTheme.colorScheme.error) },
                        onClick = {
                            menuExpanded = false
                            onDelete()
                        },
                        leadingIcon = {
                            Icon(
                                Icons.Default.Delete,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.error
                            )
                        }
                    )
                }
            }
        }
    }
}
