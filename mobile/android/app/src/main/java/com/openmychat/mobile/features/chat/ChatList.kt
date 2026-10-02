package com.openmychat.mobile.features.chat

import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imeNestedScroll
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import kotlinx.coroutines.launch

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
    onReply: (Message) -> Unit,
    onEdit: (Message) -> Unit,
    onRequestDelete: (Message) -> Unit
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
    var unseen by rememberSaveable { mutableIntStateOf(0) }

    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset <= slack } }
    LaunchedEffect(atBottom) { if (atBottom) unseen = 0 }

    // History present on the first render is shown still; only rows that arrive later animate in.
    val baseline = remember { messages.mapTo(HashSet()) { it.id } }
    val animated = remember { HashSet<Long>() }

    // A bottom-up list keeps its place by key, so a row inserted at the newest end would land below
    // the viewport. When the reader was at the bottom, stay there: the new row appears above the
    // composer and the rest slides up (animateItem). Decided before the next measure.
    val head = remember { arrayOfNulls<String>(1) }
    val wasAtBottomOnInsert = remember { BooleanArray(1) }
    val headKey = items.firstOrNull()?.key
    SideEffect {
        if (headKey != head[0]) {
            val bottom = listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset <= slack
            if (head[0] != null && bottom) listState.requestScrollToItem(0)
            wasAtBottomOnInsert[0] = bottom
            head[0] = headKey
        }
    }

    // Counting what arrived: follow only at the bottom; an own send while scrolled up jumps down;
    // otherwise count the incoming for «↓ N новых».
    val previousLast = remember { arrayOfNulls<Long>(1) }
    LaunchedEffect(messages.lastOrNull()?.id) {
        val lastId = messages.lastOrNull()?.id ?: return@LaunchedEffect
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

    val showJump by remember { derivedStateOf { JumpToLatest.isVisible(unseen, listState.firstVisibleItemIndex) } }
    // The day of the topmost visible row, unless its own separator is the row on top.
    val stickyDay by remember(items) {
        derivedStateOf {
            val visible = listState.layoutInfo.visibleItemsInfo
            if (visible.isEmpty()) return@derivedStateOf null
            var top = visible[0]
            for (info in visible) if (info.index > top.index) top = info
            when (val item = items.getOrNull(top.index)) {
                is ChatItem.Bubble -> item.day
                else -> null
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            reverseLayout = true,
            modifier = Modifier
                .fillMaxSize()
                .imeNestedScroll()
                .nestedScroll(NoKeyboardPull)
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
                        ChatBubbleRow(
                            item = item,
                            showSenderName = showSenderNames && !item.isOwn && item.startsGroup,
                            fresh = fresh,
                            actions = actions,
                            menuState = menuState,
                            onReply = onReply,
                            onEdit = onEdit,
                            onRequestDelete = onRequestDelete,
                            modifier = placement
                        )
                    }
                }
            }
        }

        StickyDatePill(stickyDay, Modifier.align(Alignment.TopCenter).padding(top = 8.dp))

        JumpToLatestPill(
            visible = showJump,
            unseen = unseen,
            onClick = {
                unseen = 0
                scope.launch { if (reduce) listState.scrollToItem(0) else listState.animateScrollToItem(0) }
            },
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp)
        )
    }
}

/**
 * Keeps the keyboard's interactive *dismiss* and drops its interactive *open*: what is left of an
 * upward drag at the newest end is consumed here, before `imeNestedScroll` would pull the keyboard up.
 */
private object NoKeyboardPull : NestedScrollConnection {
    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset =
        if (available.y < 0f) Offset(0f, available.y) else Offset.Zero

    override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity =
        if (available.y < 0f) Velocity(0f, available.y) else Velocity.Zero
}
