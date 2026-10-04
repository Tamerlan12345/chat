package com.openmychat.mobile.features.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.openmychat.mobile.R
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.components.CentyConfirmDialog
import com.openmychat.mobile.ui.components.ChatSkeleton
import com.openmychat.mobile.ui.components.ConnectionBanner
import com.openmychat.mobile.ui.components.DeliveryMark
import com.openmychat.mobile.ui.components.EmptyState
import com.openmychat.mobile.ui.components.ErrorState
import com.openmychat.mobile.ui.components.Illustration
import com.openmychat.mobile.ui.components.InlineNotice
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import com.openmychat.mobile.ui.components.MessageMenuHost
import com.openmychat.mobile.ui.components.SharedKeys
import com.openmychat.mobile.ui.components.rememberHaptics
import com.openmychat.mobile.ui.components.rememberLift
import com.openmychat.mobile.ui.components.rememberMessageMenuState
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.withFrameNanos
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Everything the chat screen can ask for; defaults keep previews and tests short. */
interface ChatActions {
    fun canEdit(message: Message): Boolean = false
    fun canDelete(message: Message): Boolean = false
    fun onBack() {}
    fun onCall() {}

    /** Тап по аватару и имени в заголовке личной переписки — карточка собеседника; null — нет карточки. */
    val onOpenCard: (() -> Unit)? get() = null
    fun onWake() {}
    fun onRetry() {}

    /**
     * Send the composer text. [replyTo] is the local reply draft («Ответить», swipe-to-reply); the
     * send queue (Task 15) carries it to the server as `reply_to_id`.
     */
    fun onSend(text: String, replyTo: Message?) {}
    fun onTyping(active: Boolean) {}
    fun onStartEdit(message: Message) {}
    fun onCancelEdit() {}
    fun onDelete(message: Message) {}

    /** Queued / sending / failed for own messages, from the send queue (Task 15); null = server state. */
    fun localMark(message: Message): DeliveryMark? = null

    /** «Повторить» on a failed send (Task 15). */
    fun onRetrySend(message: Message) {}

    /** «Удалить» on a failed send: drop it from the queue (Task 15). */
    fun onDiscardFailed(message: Message) {}
}

@Composable
fun ChatScreen(
    viewModel: ChatViewModel,
    title: String,
    avatarUrl: String? = null,
    status: String? = null,
    showBackButton: Boolean = true,
    onNavigateBack: () -> Unit,
    onStartCall: (peerId: Long, peerName: String) -> Unit,
    onOpenCard: (() -> Unit)? = null
) {
    val uiState by viewModel.uiState.collectAsState()
    val typingUser by viewModel.typingUser.collectAsState()
    val wakeCooldown by viewModel.wakeCooldownSeconds.collectAsState()
    val editingMessage by viewModel.editingMessage.collectAsState()
    val connection by viewModel.connectionState.collectAsState()
    val livePeerStatus by viewModel.peerStatus.collectAsState()
    val refreshFailed by viewModel.refreshFailed.collectAsState()
    val focus by viewModel.focus.collectAsState()
    val jumpUnavailable by viewModel.jumpUnavailable.collectAsState()
    val jumpUnavailableText = stringResource(R.string.chat_jump_unavailable)
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

    // Найденное сообщение слишком давнее: сказать, что показаны последние.
    LaunchedEffect(jumpUnavailable) {
        if (jumpUnavailable) snackbar.showSnackbar(jumpUnavailableText)
    }

    val isDirect = viewModel.conversationType == ConversationType.DIRECT
    val actions = remember(viewModel, onOpenCard) {
        object : ChatActions {
            override val onOpenCard: (() -> Unit)? = onOpenCard
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

            // The reply id travels with the send queue (Task 15); until then the draft is local.
            override fun onSend(text: String, replyTo: Message?) {
                viewModel.sendMessage(text)
                viewModel.onTyping(false)
            }
            override fun onTyping(active: Boolean) = viewModel.onTyping(active)
            override fun onStartEdit(message: Message) = viewModel.startEditing(message)
            override fun onCancelEdit() = viewModel.cancelEditing()
            override fun onDelete(message: Message) = viewModel.deleteMessage(message)
            override fun localMark(message: Message) = sendStateMark(message)
            override fun onRetrySend(message: Message) = viewModel.retrySend(message)
            override fun onDiscardFailed(message: Message) = viewModel.discardFailed(message)
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
        peerStatus = if (isDirect) livePeerStatus ?: status?.let(UserStatus::fromValue) else null,
        typingUser = typingUser,
        wakeCooldown = wakeCooldown,
        editingMessage = editingMessage,
        showBackButton = showBackButton,
        sharedKey = SharedKeys.conversation(isChannel = !isDirect, id = viewModel.targetId),
        refreshFailed = refreshFailed,
        focusMessageId = focus,
        onFocusShown = viewModel::onFocusShown
    )
}

/**
 * The chat, stateless. Planes: canvas (L2) under the history, the top bar lifts to L3 while history
 * passes under it, the composer is L3 and glued to the keyboard. The list runs bottom-up
 * (`reverseLayout`), so the newest message stays above the composer as the keyboard opens, and a
 * drag down dismisses the keyboard interactively. New messages are followed only at the bottom;
 * otherwise «↓ N новых» floats above the composer. A long press lifts the bubble over a scrim with
 * its menu; a swipe toward the start answers it.
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
    showBackButton: Boolean = true,
    /** Ties the header's avatar and name to the inbox row for the shared-element transition. */
    sharedKey: String? = null,
    /** A cached history is shown but the server could not refresh it. */
    refreshFailed: Boolean = false,
    /** Прокрутить к этому сообщению и подсветить его (переход из поиска). */
    focusMessageId: Long? = null,
    onFocusShown: () -> Unit = {}
) {
    val tokens = CentyTheme.tokens
    var pendingDelete by remember { mutableStateOf<Message?>(null) }
    var replyToId by rememberSaveable { mutableStateOf<Long?>(null) }
    val messages = (uiState as? ChatUiState.Content)?.messages.orEmpty()
    val replyTo = replyToId?.let { id -> messages.firstOrNull { it.id == id && !it.isDeleted } }
    val menuState = rememberMessageMenuState()
    val landing = rememberLandingState()
    // The history composes two frames after the screen: the chat is still invisible then (the
    // fade-through starts after 90 ms), and the transition's first frame stays light.
    // With reduce motion there is no fade to hide behind, so the history shows in the first frame.
    val reduce = LocalReduceMotion.current
    var historyReady by remember { mutableStateOf(reduce) }
    LaunchedEffect(Unit) {
        withFrameNanos { }
        withFrameNanos { }
        historyReady = true
    }
    // Ids on screen the first time the history showed (an empty chat counts): those stay still,
    // everything after animates in, including the first message of a new chat.
    val baseline = remember { HashSet<Long>() }
    val baselineTaken = remember { BooleanArray(1) }
    if (!baselineTaken[0] && uiState is ChatUiState.Content) {
        uiState.messages.mapTo(baseline) { it.id }
        baselineTaken[0] = true
    }
    val listState = rememberLazyListState()
    // History passes under the bar whenever there is older content above the viewport.
    val scrolledUnder by remember { derivedStateOf { listState.canScrollForward } }
    val lift = rememberLift(scrolledUnder && uiState is ChatUiState.Content)

    MessageMenuHost(menuState, modifier) {
      Box(Modifier.fillMaxSize()) {
        Scaffold(
            containerColor = tokens.canvas,
            // The composer takes the navigation bar and keyboard insets itself, so its surface runs
            // to the bottom edge and rises with the keyboard frame by frame.
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
                    actions = actions,
                    lift = lift,
                    sharedKey = sharedKey
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
                AnimatedVisibility(visible = refreshFailed && uiState is ChatUiState.Content) {
                    InlineNotice(
                        text = stringResource(R.string.chat_refresh_failed),
                        actionLabel = stringResource(R.string.action_retry),
                        onAction = actions::onRetry,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp).testTag("refresh-failed")
                    )
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (uiState) {
                        is ChatUiState.Loading -> DelayedSkeleton()
                        is ChatUiState.Error -> ErrorState(
                            title = stringResource(R.string.chat_error),
                            onRetry = actions::onRetry
                        )
                        is ChatUiState.Content -> if (uiState.messages.isEmpty() && typingUser == null) {
                            EmptyState(
                                illustration = Illustration.INBOX,
                                title = stringResource(R.string.chat_empty),
                                message = stringResource(R.string.chat_empty_message)
                            )
                        } else if (historyReady) {
                            MessageList(
                                listState = listState,
                                messages = uiState.messages,
                                currentUserId = currentUserId,
                                showSenderNames = !isDirect,
                                typingLabel = typingUser?.let {
                                    if (isDirect) stringResource(R.string.chat_typing_bubble) else stringResource(R.string.chat_typing_named, it)
                                },
                                actions = actions,
                                menuState = menuState,
                                landing = landing,
                                baseline = baseline,
                                onReply = { message ->
                                    actions.onCancelEdit()
                                    replyToId = message.id
                                },
                                onEdit = { message ->
                                    replyToId = null
                                    actions.onStartEdit(message)
                                },
                                onRequestDelete = { pendingDelete = it },
                                focusMessageId = focusMessageId,
                                onFocusShown = onFocusShown
                            )
                        }
                    }
                }
                ChatComposer(
                    editingMessage = editingMessage,
                    replyTo = replyTo,
                    replyToIsOwn = replyTo?.senderId == currentUserId,
                    onCancelReply = { replyToId = null },
                    onSent = { replyToId = null },
                    actions = actions,
                    landing = landing
                )
            }
        }
        LandingOverlay(landing)
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

/**
 * Loading: nothing for the first 300 ms (a cached or fast history replaces it without a flash), then
 * the skeleton fades in.
 */
@Composable
private fun DelayedSkeleton() {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(300)
        shown = true
    }
    AnimatedVisibility(visible = shown, enter = fadeIn(CentyMotion.base())) { ChatSkeleton() }
}
