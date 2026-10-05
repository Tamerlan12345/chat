package com.openmychat.mobile.features.chat

import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imeNestedScroll
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.animation.core.Animatable
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import com.openmychat.mobile.ui.theme.CentyTheme
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.ui.components.JumpToLatest
import com.openmychat.mobile.ui.components.JumpToLatestPill
import com.openmychat.mobile.ui.components.MessageMenuState
import com.openmychat.mobile.ui.components.TypingBubble
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

/** How long the sticky date stays after scrolling stops. */
private const val STICKY_DATE_LINGER = 1_000L

/** Rows from the oldest loaded message at which the page before it is asked for. */
private const val OLDER_PAGE_THRESHOLD = 8

/**
 * The history, newest at the bottom, laid out bottom-up (`reverseLayout`): index 0 is the newest row,
 * so the conversation stays anchored above the composer while the keyboard animates. Dragging the
 * list down hides the keyboard with the finger (`imeNestedScroll`); pulling up at the newest end
 * never opens it.
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
internal fun MessageList(
    listState: LazyListState,
    messages: List<Message>,
    currentUserId: Long,
    showSenderNames: Boolean,
    typingLabel: String?,
    actions: ChatActions,
    menuState: MessageMenuState,
    landing: LandingState,
    /** Ids already on screen when the chat opened: shown still. Everything else animates in. */
    baseline: Set<Long>,
    onReply: (Message) -> Unit,
    onEdit: (Message) -> Unit,
    onRequestDelete: (Message) -> Unit,
    /** Сообщение из поиска: прокрутить к нему (примерно в середину экрана) и подсветить 1,2 с. */
    focusMessageId: Long? = null,
    onFocusShown: () -> Unit = {}
) {
    // A derived state: when the send queue keeps its marks in snapshot state, a changed mark rebuilds the rows.
    val chronological by remember(messages, currentUserId, actions) {
        derivedStateOf { buildChatItems(messages, currentUserId, markOverride = actions::localMark) }
    }
    val typing = typingLabel != null
    // Newest first for the bottom-up list.
    val items = remember(chronological, typing) {
        ArrayList<ChatItem>(chronological.size + 1).apply {
            if (typing) add(ChatItem.Typing)
            for (i in chronological.indices.reversed()) add(chronological[i])
        }
    }
    val scope = rememberCoroutineScope()
    val reduce = LocalReduceMotion.current
    val slack = with(LocalDensity.current) { 8.dp.roundToPx() }
    val strings = rememberChatRowStrings()
    var unseen by rememberSaveable { mutableIntStateOf(0) }

    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset <= slack } }
    LaunchedEffect(atBottom) { if (atBottom) unseen = 0 }

    val animated = remember { HashSet<Long>() }

    // Two snapshots, taken before the next measure:
    // - when the newest *row* changes (a message, or the typing bubble) and the reader was at the
    //   bottom, stay there: a bottom-up list keeps its place by key, so a row inserted at the newest
    //   end would otherwise land below the viewport;
    // - when the newest *message* changes, remember whether the reader was at the bottom for the
    //   follow rule. Keyed on the message, not the row, so the typing bubble on top never hides it.
    val head = remember { arrayOfNulls<String>(1) }
    val newestSeen = remember { arrayOfNulls<Long>(1) }
    val wasAtBottomOnInsert = remember { BooleanArray(1) }
    val headKey = items.firstOrNull()?.key
    val newestId = messages.lastOrNull()?.id
    SideEffect {
        val bottom = listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset <= slack
        if (headKey != head[0]) {
            if (head[0] != null && bottom) listState.requestScrollToItem(0)
            head[0] = headKey
        }
        if (newestId != newestSeen[0]) {
            wasAtBottomOnInsert[0] = bottom
            newestSeen[0] = newestId
        }
    }

    // Counting what arrived: follow only at the bottom; an own send while scrolled up jumps down;
    // otherwise count the incoming for «↓ N новых».
    val previousLast = remember { arrayOfNulls<Long>(1) }
    LaunchedEffect(newestId) {
        val lastId = newestId ?: return@LaunchedEffect
        val before = previousLast[0]
        previousLast[0] = lastId
        val appended = FollowPolicy.appendedSince(before, messages)
        if (appended.isEmpty()) return@LaunchedEffect
        val wasAtBottom = wasAtBottomOnInsert[0]
        val decision = FollowPolicy.onAppended(
            atBottom = wasAtBottom,
            ownAppended = appended.any { it.senderId == currentUserId },
            incomingAppended = appended.count { it.senderId != currentUserId },
            unseen = unseen
        )
        unseen = decision.unseen
        if (decision.scrollToEnd && !wasAtBottom) {
            if (reduce) listState.scrollToItem(0) else listState.animateScrollToItem(0)
        }
    }

    // Older history (`beforeId`): reaching the oldest rows asks for the page before them.
    LaunchedEffect(listState, items.size) {
        snapshotFlow { (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1) >= items.size - OLDER_PAGE_THRESHOLD }
            .distinctUntilChanged()
            .filter { it }
            .collect { actions.onLoadOlder() }
    }

    val showJump by remember { derivedStateOf { JumpToLatest.isVisible(unseen, listState.firstVisibleItemIndex) } }

    var pulseId by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(focusMessageId, items) {
        val id = focusMessageId ?: return@LaunchedEffect
        val index = items.indexOfFirst { it is ChatItem.Bubble && it.message.id == id }
        if (index < 0) return@LaunchedEffect
        listState.scrollToItem(index)
        // Снизу (reverseLayout) — к середине экрана, если ниже есть более новые сообщения.
        val viewport = listState.layoutInfo.viewportSize.height
        val size = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }?.size ?: 0
        val lift = (viewport / 2 - size / 2).coerceAtLeast(0)
        if (lift > 0) listState.scrollBy(-lift.toFloat())
        pulseId = id
        onFocusShown()
    }

    // The sticky date shows only while the history moves (and a second after), never while its own
    // separator is on screen, and never when the history does not fill the viewport.
    var recentlyScrolled by remember { mutableStateOf(false) }
    LaunchedEffect(listState) {
        // Driven by the history actually moving (not by a scroll flag): every change of the first
        // visible row or its offset shows the pill, and a second without movement hides it.
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .drop(1)
            .collectLatest {
                recentlyScrolled = true
                delay(STICKY_DATE_LINGER)
                recentlyScrolled = false
            }
    }
    val stickyDay by remember(items) {
        derivedStateOf {
            if (!listState.canScrollForward && !listState.canScrollBackward) return@derivedStateOf null
            val visible = listState.layoutInfo.visibleItemsInfo
            if (visible.isEmpty()) return@derivedStateOf null
            var top = visible[0]
            for (info in visible) if (info.index > top.index) top = info
            val day = (items.getOrNull(top.index) as? ChatItem.Bubble)?.day ?: return@derivedStateOf null
            val separatorKey = "day-$day"
            if (visible.any { it.key == separatorKey }) null else day
        }
    }

    val imeVisible = WindowInsets.isImeVisible
    val imeVisibleNow = rememberUpdatedState(imeVisible)
    val keyboardPull = remember { NoKeyboardPull { imeVisibleNow.value } }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            reverseLayout = true,
            modifier = Modifier
                .fillMaxSize()
                .imeNestedScroll()
                .nestedScroll(keyboardPull)
                .testTag("message-list"),
            contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 12.dp)
        ) {
            items(items, key = { it.key }, contentType = { it::class }) { item ->
                val placement = Modifier.animateItem(
                    fadeInSpec = null,
                    placementSpec = if (reduce) null else tween(CentyMotion.SEND, easing = CentyMotion.EaseOutExpo),
                    fadeOutSpec = tween(CentyMotion.FAST)
                )
                when (item) {
                    is ChatItem.Day -> DaySeparatorRow(item.day, placement)
                    is ChatItem.Typing -> Box(placement.fillMaxWidth().padding(top = 10.dp)) {
                        TypingBubble(label = typingLabel.orEmpty())
                    }
                    is ChatItem.Bubble -> {
                        val id = item.message.id
                        val fresh = remember(id) { id !in baseline && animated.add(id) }
                        val pulsing = pulseId == id
                        ChatBubbleRow(
                            item = item,
                            strings = strings,
                            showSenderName = showSenderNames && !item.isOwn && item.startsGroup,
                            fresh = fresh,
                            actions = actions,
                            menuState = menuState,
                            landing = landing,
                            onReply = onReply,
                            onEdit = onEdit,
                            onRequestDelete = onRequestDelete,
                            modifier = placement.highlightPulse(pulsing) { if (pulseId == id) pulseId = null }
                        )
                    }
                }
            }
        }

        StickyDatePill(if (recentlyScrolled) stickyDay else null, Modifier.align(Alignment.TopCenter).padding(top = 8.dp))

        // End-aligned above the composer, clear of the text column.
        JumpToLatestPill(
            visible = showJump,
            unseen = unseen,
            onClick = {
                unseen = 0
                scope.launch { if (reduce) listState.scrollToItem(0) else listState.animateScrollToItem(0) }
            },
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 12.dp, bottom = 12.dp)
        )
    }
}

/**
 * Keeps the keyboard's interactive *dismiss* and drops its interactive *open*: while the keyboard
 * is hidden, what is left of an upward drag at the newest end is consumed here, before
 * `imeNestedScroll` would pull the keyboard up. With the keyboard open nothing is consumed, so the
 * stretch overscroll stays.
 */
private class NoKeyboardPull(private val imeVisible: () -> Boolean) : NestedScrollConnection {
    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset =
        if (available.y < 0f && !imeVisible()) Offset(0f, available.y) else Offset.Zero

    override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity =
        if (available.y < 0f && !imeVisible()) Velocity(0f, available.y) else Velocity.Zero
}

/**
 * Подсветка найденного сообщения: мягкая заливка accent проявляется (200 мс), держится и гаснет —
 * всего 1,2 с. При reduce motion — без нарастания: включена 1,2 с и выключена.
 */
@Composable
internal fun Modifier.highlightPulse(active: Boolean, onDone: () -> Unit): Modifier {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val level = remember { Animatable(0f) }
    val done = rememberUpdatedState(onDone)
    LaunchedEffect(active) {
        if (!active) return@LaunchedEffect
        if (reduce) {
            level.snapTo(1f)
            delay(1_200)
            level.snapTo(0f)
        } else {
            level.animateTo(1f, tween(200, easing = CentyMotion.EaseOut))
            delay(500)
            level.animateTo(0f, tween(500, easing = CentyMotion.EaseOut))
        }
        done.value()
    }
    val color = tokens.primary
    return drawBehind {
        val a = level.value
        if (a > 0f) {
            drawRoundRect(
                color = color.copy(alpha = 0.18f * a),
                cornerRadius = CornerRadius(12.dp.toPx())
            )
        }
    }.semantics { if (active) testTag = "message-highlight" }
}
