package com.openmychat.mobile.features.chat

import android.os.Build
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.openmychat.mobile.R
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.util.DateTimeUtils
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.components.CentyConfirmDialog
import com.openmychat.mobile.ui.components.ChatSkeleton
import com.openmychat.mobile.ui.components.ConnectionBanner
import com.openmychat.mobile.ui.components.DeliveryGlyph
import com.openmychat.mobile.ui.components.DeliveryMark
import com.openmychat.mobile.ui.components.EmptyState
import com.openmychat.mobile.ui.components.ErrorState
import com.openmychat.mobile.ui.components.LocalSnackbarAnchor
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import com.openmychat.mobile.ui.components.TypingIndicator
import com.openmychat.mobile.ui.components.presenceLabel
import com.openmychat.mobile.ui.components.rememberHaptics
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Everything the chat screen can ask for; defaults keep previews and tests short. */
interface ChatActions {
    fun canEdit(message: Message): Boolean = false
    fun canDelete(message: Message): Boolean = false
    fun onBack() {}
    fun onCall() {}
    fun onWake() {}
    fun onRetry() {}
    fun onSend(text: String) {}
    fun onTyping(active: Boolean) {}
    fun onStartEdit(message: Message) {}
    fun onCancelEdit() {}
    fun onDelete(message: Message) {}
}

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
    val typingUser by viewModel.typingUser.collectAsState()
    val wakeCooldown by viewModel.wakeCooldownSeconds.collectAsState()
    val editingMessage by viewModel.editingMessage.collectAsState()
    val connection by viewModel.connectionState.collectAsState()
    val livePeerStatus by viewModel.peerStatus.collectAsState()
    val snackbar = LocalSnackbarHostState.current
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    val wakeSent = stringResource(R.string.chat_wake_sent)

    // Nav3 gives each entry its own lifecycle: the chat counts as open only while it is resumed,
    // not while it waits in the back stack under a call or behind another tab.
    LifecycleResumeEffect(viewModel) {
        viewModel.onVisibilityChanged(true)
        onPauseOrDispose { viewModel.onVisibilityChanged(false) }
    }

    val isDirect = viewModel.conversationType == ConversationType.DIRECT
    val actions = remember(viewModel) {
        object : ChatActions {
            override fun canEdit(message: Message) = viewModel.canEditMessage(message)
            override fun canDelete(message: Message) = viewModel.canDeleteMessage(message)
            override fun onBack() = onNavigateBack()
            override fun onCall() = onStartCall(viewModel.targetId, title)
            override fun onWake() {
                viewModel.sendWake()
                haptics.confirm()
                scope.launch { snackbar.showSnackbar(wakeSent) }
            }
            override fun onRetry() = viewModel.loadMessages()
            override fun onSend(text: String) {
                viewModel.sendMessage(text)
                viewModel.onTyping(false)
            }
            override fun onTyping(active: Boolean) = viewModel.onTyping(active)
            override fun onStartEdit(message: Message) = viewModel.startEditing(message)
            override fun onCancelEdit() = viewModel.cancelEditing()
            override fun onDelete(message: Message) = viewModel.deleteMessage(message)
        }
    }

    ChatContent(
        title = title,
        isDirect = isDirect,
        uiState = uiState,
        currentUserId = viewModel.currentUserId,
        connectionState = connection,
        actions = actions,
        avatarUrl = avatarUrl,
        peerStatus = if (isDirect) livePeerStatus ?: UserStatus.fromValue(status) else null,
        typingUser = typingUser,
        wakeCooldown = wakeCooldown,
        editingMessage = editingMessage,
        showBackButton = showBackButton
    )
}

/**
 * The chat, stateless: canvas background, date pills, grouped bubbles with the desktop tail,
 * composer above the keyboard. New messages are followed only when the reader is at the bottom;
 * otherwise a «↓ N новых» pill appears.
 */
@Composable
fun ChatContent(
    title: String,
    isDirect: Boolean,
    uiState: ChatUiState,
    currentUserId: Long,
    connectionState: ConnectionState,
    actions: ChatActions,
    modifier: Modifier = Modifier,
    avatarUrl: String? = null,
    peerStatus: UserStatus? = null,
    typingUser: String? = null,
    wakeCooldown: Int = 0,
    editingMessage: Message? = null,
    showBackButton: Boolean = true
) {
    val tokens = CentyTheme.tokens
    var pendingDelete by remember { mutableStateOf<Message?>(null) }

    Scaffold(
        modifier = modifier,
        containerColor = tokens.canvas,
        // The composer takes the navigation bar and keyboard insets itself, so its surface runs
        // to the bottom edge and rises with the keyboard.
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            ChatTopBar(
                title = title,
                avatarUrl = avatarUrl,
                isDirect = isDirect,
                peerStatus = peerStatus,
                typingUser = typingUser,
                wakeCooldown = wakeCooldown,
                showBackButton = showBackButton,
                actions = actions
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .consumeWindowInsets(innerPadding)
        ) {
            ConnectionBanner(connectionState)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (uiState) {
                    is ChatUiState.Loading -> ChatSkeleton()
                    is ChatUiState.Error -> ErrorState(
                        title = stringResource(R.string.chat_error),
                        onRetry = actions::onRetry
                    )
                    is ChatUiState.Content -> if (uiState.messages.isEmpty()) {
                        EmptyState(
                            icon = Icons.Outlined.ChatBubbleOutline,
                            title = stringResource(R.string.chat_empty),
                            message = stringResource(R.string.chat_empty_message)
                        )
                    } else {
                        MessageList(
                            messages = uiState.messages,
                            currentUserId = currentUserId,
                            showSenderNames = !isDirect,
                            actions = actions,
                            onRequestDelete = { pendingDelete = it }
                        )
                    }
                }
            }
            AnimatedVisibility(
                visible = editingMessage != null,
                enter = expandVertically(CentyMotion.base()) + fadeIn(CentyMotion.base()),
                exit = shrinkVertically(CentyMotion.fast()) + fadeOut(CentyMotion.fast())
            ) {
                var shown by remember { mutableStateOf(editingMessage) }
                if (editingMessage != null) shown = editingMessage
                shown?.let { EditBanner(it, onCancel = actions::onCancelEdit) }
            }
            Composer(editingMessage = editingMessage, actions = actions)
        }
    }

    pendingDelete?.let { message ->
        CentyConfirmDialog(
            title = stringResource(R.string.chat_delete_title),
            message = stringResource(R.string.chat_delete_message),
            confirmText = stringResource(R.string.action_delete),
            isDestructive = true,
            confirmTestTag = "confirm-delete",
            onConfirm = {
                pendingDelete = null
                actions.onDelete(message)
            },
            onDismiss = { pendingDelete = null }
        )
    }
}

@Composable
private fun ChatTopBar(
    title: String,
    avatarUrl: String?,
    isDirect: Boolean,
    peerStatus: UserStatus?,
    typingUser: String?,
    wakeCooldown: Int,
    showBackButton: Boolean,
    actions: ChatActions
) {
    val tokens = CentyTheme.tokens
    Column {
        TopAppBar(
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = tokens.list,
                titleContentColor = tokens.textStrong,
                navigationIconContentColor = tokens.textSecondary,
                actionIconContentColor = tokens.textSecondary
            ),
            navigationIcon = {
                if (showBackButton) {
                    IconButton(onClick = actions::onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                }
            },
            title = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CentyAvatar(name = title, avatarUrl = avatarUrl, status = peerStatus, size = 36.dp, isChannel = !isDirect)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.semantics(mergeDescendants = true) { heading() }) {
                        Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val typingText = typingUser?.let {
                            if (isDirect) stringResource(R.string.chat_typing) else stringResource(R.string.chat_typing_named, it)
                        }
                        AnimatedContent(
                            targetState = typingText to peerStatus,
                            transitionSpec = { fadeIn(CentyMotion.base()) togetherWith fadeOut(CentyMotion.fast()) },
                            label = "chat-subtitle"
                        ) { (typing, status) ->
                            when {
                                typing != null -> TypingIndicator(typing, style = MaterialTheme.typography.labelMedium)
                                status != null -> Text(
                                    presenceLabel(status),
                                    style = MaterialTheme.typography.labelMedium,
                                    color = tokens.textDim,
                                    maxLines = 1
                                )
                            }
                        }
                    }
                }
            },
            actions = {
                if (isDirect) {
                    val wakeLabel = if (wakeCooldown > 0) {
                        stringResource(R.string.chat_wake_cooldown, wakeCooldown)
                    } else {
                        stringResource(R.string.chat_wake)
                    }
                    IconButton(
                        onClick = actions::onWake,
                        enabled = wakeCooldown == 0,
                        modifier = Modifier.semantics { contentDescription = wakeLabel }
                    ) {
                        if (wakeCooldown > 0) {
                            Text("$wakeCooldown", style = MaterialTheme.typography.labelMedium, color = tokens.textDim)
                        } else {
                            Icon(Icons.Outlined.NotificationsActive, contentDescription = null)
                        }
                    }
                    IconButton(onClick = actions::onCall) {
                        Icon(Icons.Outlined.Call, contentDescription = stringResource(R.string.chat_call))
                    }
                }
            }
        )
        HorizontalDivider(color = tokens.border)
    }
}

@Composable
private fun MessageList(
    messages: List<Message>,
    currentUserId: Long,
    showSenderNames: Boolean,
    actions: ChatActions,
    onRequestDelete: (Message) -> Unit
) {
    val items = remember(messages, currentUserId) { buildChatItems(messages, currentUserId) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val reduce = LocalReduceMotion.current
    var unseen by rememberSaveable { mutableIntStateOf(0) }
    var previousLastId by remember { mutableStateOf<Long?>(null) }

    // History present on the first render is shown still; only messages that arrive later animate in.
    val baseline = remember { messages.mapTo(HashSet()) { it.id } }
    val animated = remember { HashSet<Long>() }

    val atBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()
            last == null || (last.index >= info.totalItemsCount - 1 && last.offset + last.size <= info.viewportEndOffset + 8)
        }
    }
    LaunchedEffect(atBottom) { if (atBottom) unseen = 0 }

    LaunchedEffect(messages.lastOrNull()?.id) {
        val lastId = messages.lastOrNull()?.id ?: return@LaunchedEffect
        val before = previousLastId
        previousLastId = lastId
        if (before == null) {
            listState.scrollToItem(items.lastIndex)
            return@LaunchedEffect
        }
        val appended = FollowPolicy.appendedSince(before, messages)
        if (appended.isEmpty()) return@LaunchedEffect
        // The list keeps its place by key, so "was at the bottom" is: the previous last bubble
        // is still fully on screen.
        val info = listState.layoutInfo
        val previousBubble = info.visibleItemsInfo.firstOrNull { it.key == "msg-$before" }
        val wasAtBottom = previousBubble != null && previousBubble.offset + previousBubble.size <= info.viewportEndOffset + 8
        val decision = FollowPolicy.onAppended(
            atBottom = wasAtBottom,
            ownAppended = appended.any { it.senderId == currentUserId },
            incomingAppended = appended.count { it.senderId != currentUserId },
            unseen = unseen
        )
        unseen = decision.unseen
        if (decision.scrollToEnd) {
            if (reduce) listState.scrollToItem(items.lastIndex) else listState.animateScrollToItem(items.lastIndex)
        }
    }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().testTag("message-list"),
            contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 12.dp)
        ) {
            items(items, key = { it.key }, contentType = { it::class }) { item ->
                val placement = Modifier.animateItem(
                    fadeInSpec = null,
                    placementSpec = if (reduce) null else tween(CentyMotion.BASE, easing = CentyMotion.EaseOut),
                    fadeOutSpec = tween(CentyMotion.FAST)
                )
                when (item) {
                    is ChatItem.Day -> DayPill(item.date, placement)
                    is ChatItem.Bubble -> {
                        val id = item.message.id
                        val fresh = remember(id) { id !in baseline && animated.add(id) }
                        MessageBubble(
                            item = item,
                            showSenderName = showSenderNames && !item.isOwn && item.startsGroup,
                            animateIn = fresh,
                            canEdit = actions.canEdit(item.message),
                            canDelete = actions.canDelete(item.message),
                            onEdit = { actions.onStartEdit(item.message) },
                            onDelete = { onRequestDelete(item.message) },
                            modifier = placement
                        )
                    }
                }
            }
        }

        NewMessagesPill(
            count = unseen,
            onClick = {
                unseen = 0
                scope.launch {
                    if (reduce) listState.scrollToItem(items.lastIndex) else listState.animateScrollToItem(items.lastIndex)
                }
            },
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp)
        )
    }
}

@Composable
private fun NewMessagesPill(count: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val reduce = LocalReduceMotion.current
    var last by remember { mutableIntStateOf(count) }
    if (count > 0) last = count
    val description = pluralStringResource(R.plurals.new_messages_jump, last, last)
    AnimatedVisibility(
        visible = count > 0,
        modifier = modifier,
        // Desktop `jump-pill-in`: 8 px rise and fade.
        enter = if (reduce) fadeIn(CentyMotion.fast()) else slideInVertically(CentyMotion.base()) { it / 3 } + fadeIn(CentyMotion.base()),
        exit = if (reduce) fadeOut(CentyMotion.fast()) else slideOutVertically(CentyMotion.fast()) { it / 3 } + fadeOut(CentyMotion.fast())
    ) {
        val tokens = CentyTheme.tokens
        Surface(
            onClick = onClick,
            shape = CircleShape,
            color = tokens.primary,
            contentColor = androidx.compose.ui.graphics.Color.White,
            shadowElevation = 3.dp,
            modifier = Modifier
                .heightIn(min = 40.dp)
                .testTag("new-messages-pill")
                .semantics { contentDescription = description }
        ) {
            Row(
                modifier = Modifier.padding(start = 10.dp, end = 14.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Icon(Icons.Rounded.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(pluralStringResource(R.plurals.new_messages_pill, last, last), style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
private fun DayPill(date: LocalDate, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    val today = LocalDate.now()
    val label = when (date) {
        today -> stringResource(R.string.chat_today)
        today.minusDays(1) -> stringResource(R.string.chat_yesterday)
        else -> {
            val pattern = if (date.year == today.year) "d MMMM" else "d MMMM yyyy"
            date.format(DateTimeFormatter.ofPattern(pattern, Locale.forLanguageTag("ru")))
        }
    }
    Box(modifier.fillMaxWidth().padding(top = 16.dp, bottom = 6.dp), contentAlignment = Alignment.Center) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = tokens.textDim,
            modifier = Modifier
                .background(tokens.canvas, CircleShape)
                .border(1.dp, tokens.border, CircleShape)
                .padding(horizontal = 10.dp, vertical = 3.dp)
                .semantics { heading() }
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    item: ChatItem.Bubble,
    showSenderName: Boolean,
    animateIn: Boolean,
    canEdit: Boolean,
    canDelete: Boolean,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier
) {
    val message = item.message
    val isOwn = item.isOwn
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val clipboard = LocalClipboardManager.current
    val snackbar = LocalSnackbarHostState.current
    val scope = rememberCoroutineScope()
    val copied = stringResource(R.string.chat_copied)
    var menuOpen by remember { mutableStateOf(false) }

    // Entrance: own bubbles lift out of the composer (scale .96 → 1, 14dp rise), incoming ones
    // fade and rise 8dp. Reduce motion: fade only.
    val progress = remember { Animatable(if (animateIn) 0f else 1f) }
    LaunchedEffect(Unit) {
        if (animateIn) {
            progress.animateTo(1f, tween(if (reduce) CentyMotion.FAST else if (isOwn) CentyMotion.SEND else CentyMotion.INCOMING, easing = CentyMotion.EaseOut))
        }
    }
    val rise = with(LocalDensity.current) { (if (isOwn) 14.dp else 8.dp).toPx() }

    val time = DateTimeUtils.formatTime(message.createdAt)
    val sender = if (isOwn) stringResource(R.string.chat_from_you) else message.senderName
    val body = if (message.isDeleted) stringResource(R.string.chat_deleted) else message.text
    val mark = item.mark
    val markLabel = mark?.let { stringResource(deliveryLabel(it)) }
    val description = stringResource(R.string.chat_message_description, sender, time, body) + (markLabel?.let { ", $it" } ?: "")
    val copyLabel = stringResource(R.string.action_copy)
    val editLabel = stringResource(R.string.action_edit)
    val deleteLabel = stringResource(R.string.action_delete)
    val copy = {
        clipboard.setText(AnnotatedString(message.text))
        // Android 13+ confirms copies itself.
        if (Build.VERSION.SDK_INT < 33) scope.launch { snackbar.showSnackbar(copied) }
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = if (item.startsGroup) 6.dp else 2.dp),
        horizontalArrangement = if (isOwn) Arrangement.End else Arrangement.Start
    ) {
        val shape = RoundedCornerShape(
            topStart = if (!isOwn && item.startsGroup) CentyRadius.tail else CentyRadius.control,
            topEnd = if (isOwn && item.startsGroup) CentyRadius.tail else CentyRadius.control,
            bottomStart = CentyRadius.control,
            bottomEnd = CentyRadius.control
        )
        Box(Modifier.widthIn(max = 320.dp).fillMaxWidth(0.84f), contentAlignment = if (isOwn) Alignment.CenterEnd else Alignment.CenterStart) {
            Column(
                modifier = Modifier
                    .graphicsLayer {
                        val p = progress.value
                        alpha = p
                        if (!reduce) {
                            translationY = (1f - p) * rise
                            val scale = if (isOwn) 0.96f + 0.04f * p else 1f
                            scaleX = scale
                            scaleY = scale
                            transformOrigin = TransformOrigin(if (isOwn) 1f else 0f, 1f)
                        }
                    }
                    .background(if (isOwn) tokens.primarySoft else tokens.card, shape)
                    .border(1.dp, if (isOwn) tokens.primaryLine else tokens.border, shape)
                    // combinedClickable performs the long-press haptic itself. A tap opens the same menu,
                    // so TalkBack's click is a real action rather than a no-op.
                    .combinedClickable(
                        onClick = { menuOpen = true },
                        onClickLabel = stringResource(R.string.chat_message_actions),
                        onLongClick = { menuOpen = true },
                        onLongClickLabel = stringResource(R.string.chat_message_actions)
                    )
                    .semantics(mergeDescendants = true) {
                        contentDescription = description
                        customActions = buildList {
                            add(CustomAccessibilityAction(copyLabel) { copy(); true })
                            if (canEdit) add(CustomAccessibilityAction(editLabel) { onEdit(); true })
                            if (canDelete) add(CustomAccessibilityAction(deleteLabel) { onDelete(); true })
                        }
                    }
                    .padding(horizontal = 12.dp, vertical = 7.dp)
            ) {
                if (showSenderName) {
                    Text(
                        message.senderName,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = tokens.accentText,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(Modifier.size(2.dp))
                }
                val reply = message.metadata?.replyText
                if (!message.isDeleted && !reply.isNullOrBlank()) ReplyQuote(message.metadata?.replySenderName, reply)
                val textColor = if (isOwn) tokens.accentText else tokens.textMain
                when {
                    message.isDeleted -> Text(body, style = MaterialTheme.typography.bodyLarge, fontStyle = FontStyle.Italic, color = tokens.textDim)
                    message.type == MessageType.FILE -> FileChip(message.fileOriginalName ?: message.metadata?.fileName ?: message.text, message.metadata?.size)
                    else -> Text(body, style = MaterialTheme.typography.bodyLarge, color = textColor)
                }
                Row(
                    modifier = Modifier.align(Alignment.End).padding(top = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    // On primary-soft, textDim drops below 4.5:1 in dark; the own footer uses textSecondary.
                    val meta = if (isOwn) tokens.textSecondary else tokens.textDim
                    if (!message.updatedAt.isNullOrBlank() && !message.isDeleted) {
                        Text(stringResource(R.string.chat_edited), style = MaterialTheme.typography.labelSmall, color = meta)
                    }
                    Text(time, style = MaterialTheme.typography.labelSmall, color = meta)
                    if (mark != null) DeliveryGlyph(mark, tint = meta)
                }
            }
            DropdownMenu(
                expanded = menuOpen,
                onDismissRequest = { menuOpen = false },
                containerColor = tokens.elevated,
                shape = RoundedCornerShape(CentyRadius.card)
            ) {
                DropdownMenuItem(
                    text = { Text(copyLabel) },
                    leadingIcon = { Icon(Icons.Outlined.ContentCopy, contentDescription = null) },
                    onClick = {
                        menuOpen = false
                        copy()
                    }
                )
                if (canEdit) {
                    DropdownMenuItem(
                        text = { Text(editLabel) },
                        leadingIcon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                        onClick = {
                            menuOpen = false
                            onEdit()
                        }
                    )
                }
                if (canDelete) {
                    DropdownMenuItem(
                        text = { Text(deleteLabel, color = tokens.dangerText) },
                        leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = tokens.dangerText) },
                        onClick = {
                            menuOpen = false
                            onDelete()
                        }
                    )
                }
            }
        }
    }
}

private fun deliveryLabel(mark: DeliveryMark): Int = when (mark) {
    DeliveryMark.QUEUED -> R.string.delivery_queued
    DeliveryMark.SENT -> R.string.delivery_sent
    DeliveryMark.DELIVERED -> R.string.delivery_delivered
    DeliveryMark.READ -> R.string.delivery_read
    DeliveryMark.FAILED -> R.string.delivery_failed
}

/** Reply quote inside the bubble with a 2dp indigo bar (brief). */
@Composable
private fun ReplyQuote(sender: String?, text: String) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = Modifier
            .padding(bottom = 4.dp)
            .background(tokens.hover, RoundedCornerShape(6.dp))
            .heightIn(min = 32.dp)
    ) {
        Box(Modifier.width(2.dp).heightIn(min = 32.dp).background(tokens.primary))
        Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
            Text(
                sender?.takeIf { it.isNotBlank() } ?: stringResource(R.string.chat_reply_to),
                style = MaterialTheme.typography.labelMedium,
                color = tokens.accentText,
                maxLines = 1
            )
            Text(text, style = MaterialTheme.typography.bodySmall, color = tokens.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun FileChip(name: String, size: Long?) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = Modifier
            .background(tokens.hover, RoundedCornerShape(6.dp))
            .border(1.dp, tokens.borderStrong, RoundedCornerShape(6.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Icon(Icons.Outlined.Description, contentDescription = null, tint = tokens.accentText, modifier = Modifier.size(22.dp))
        Column {
            Text(name, style = MaterialTheme.typography.bodyMedium, color = tokens.textStrong, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                size?.let { formatBytes(it) } ?: stringResource(R.string.chat_file),
                style = MaterialTheme.typography.labelSmall,
                color = tokens.textDim
            )
        }
    }
}

@Composable
private fun formatBytes(bytes: Long): String = when {
    bytes < 1024 -> stringResource(R.string.file_size_bytes, bytes)
    bytes < 1024 * 1024 -> stringResource(R.string.file_size_kb, bytes / 1024.0)
    else -> stringResource(R.string.file_size_mb, bytes / (1024.0 * 1024))
}

@Composable
private fun EditBanner(message: Message, onCancel: () -> Unit) {
    val tokens = CentyTheme.tokens
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(tokens.list)
            .padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(Icons.Outlined.Edit, contentDescription = null, tint = tokens.accentText, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.chat_editing), style = MaterialTheme.typography.labelLarge, color = tokens.accentText)
            Text(message.text, style = MaterialTheme.typography.bodySmall, color = tokens.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = onCancel) {
            Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.chat_cancel_edit))
        }
    }
}

@Composable
private fun Composer(editingMessage: Message?, actions: ChatActions) {
    val tokens = CentyTheme.tokens
    val haptics = rememberHaptics()
    val reduce = LocalReduceMotion.current
    val anchor = LocalSnackbarAnchor.current
    val density = LocalDensity.current
    DisposableEffect(anchor) { onDispose { anchor.bottom = 0.dp } }
    var text by rememberSaveable { mutableStateOf("") }
    // Only a real change of the edited message replaces the text. On re-entry (after a call or a
    // tab switch) the restored id matches, so the saved draft is kept.
    var editingId by rememberSaveable { mutableStateOf<Long?>(null) }
    LaunchedEffect(editingMessage?.id) {
        val id = editingMessage?.id
        if (id != editingId) {
            editingId = id
            text = editingMessage?.text.orEmpty()
        }
    }
    val canSend = text.isNotBlank()
    val send = {
        if (canSend) {
            actions.onSend(text)
            text = ""
            haptics.tick()
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(tokens.list)
            .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
    ) {
        HorizontalDivider(color = tokens.border)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .onSizeChanged { anchor.bottom = with(density) { it.height.toDp() } }
                .padding(start = 12.dp, end = 8.dp, top = 8.dp, bottom = 8.dp)
                .testTag("composer"),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            val shape = RoundedCornerShape(CentyRadius.control)
            BasicTextField(
                value = text,
                onValueChange = {
                    text = it
                    actions.onTyping(it.isNotBlank())
                },
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = tokens.textMain),
                cursorBrush = SolidColor(tokens.accentText),
                maxLines = 6,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                modifier = Modifier.weight(1f).testTag("composer-field"),
                decorationBox = { inner ->
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .background(tokens.card, shape)
                            .border(1.dp, tokens.borderStrong, shape)
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                        contentAlignment = Alignment.CenterStart
                    ) {
                        if (text.isEmpty()) {
                            Text(stringResource(R.string.chat_composer_hint), style = MaterialTheme.typography.bodyLarge, color = tokens.textDim)
                        }
                        inner()
                    }
                }
            )
            // The send button turns into a filled primary button only when there is text.
            val container by animateColorAsState(if (canSend) tokens.primary else tokens.hover, CentyMotion.base(), label = "send-bg")
            val content by animateColorAsState(if (canSend) androidx.compose.ui.graphics.Color.White else tokens.textDim, CentyMotion.base(), label = "send-fg")
            val scale by animateFloatAsState(if (canSend || reduce) 1f else 0.92f, CentyMotion.base(), label = "send-scale")
            val label = stringResource(if (editingMessage != null) R.string.chat_save_edit else R.string.chat_send)
            IconButton(
                onClick = send,
                enabled = canSend,
                modifier = Modifier
                    .size(48.dp)
                    .graphicsLayer { scaleX = scale; scaleY = scale }
                    .background(container, RoundedCornerShape(CentyRadius.control))
            ) {
                Icon(
                    imageVector = if (editingMessage != null) Icons.Rounded.Check else Icons.AutoMirrored.Rounded.Send,
                    contentDescription = label,
                    tint = content
                )
            }
        }
    }
}
