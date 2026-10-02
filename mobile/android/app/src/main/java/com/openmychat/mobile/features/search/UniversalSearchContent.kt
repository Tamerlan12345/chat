package com.openmychat.mobile.features.search

import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imeNestedScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.core.util.DateTimeUtils
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.features.people.PersonRow
import com.openmychat.mobile.features.people.highlighted
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.components.CentyTextButton
import com.openmychat.mobile.ui.components.EmptyState
import com.openmychat.mobile.ui.components.Illustration
import com.openmychat.mobile.ui.components.SkeletonBlock
import com.openmychat.mobile.ui.components.SkeletonContainer
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion

/** Что умеет общий поиск; по умолчанию — ничего (превью и тесты). */
interface UniversalSearchActions {
    fun onOpenPerson(match: com.openmychat.mobile.features.people.Person) {}
    fun onOpenChannel(channel: Channel) {}
    fun onOpenRecent(item: RecentItem) {}
    fun onShowAllPeople(query: String) {}
    fun onOpenMessage(hit: MessageHit) {}
    fun onClear() {}
}

/**
 * Выдача общего поиска в «Чатах»: пустая строка — «Недавние»; иначе разделы в постоянном порядке
 * «Люди · Каналы · Сообщения». Люди и каналы — сразу, сообщения подтягиваются с сервера и до
 * ответа показаны двумя строками-заготовками; разделы не ждут друг друга.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun UniversalSearchContent(
    state: UniversalSearchState,
    actions: UniversalSearchActions,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues()
) {
    if (state.nothingFound) {
        EmptyState(
            illustration = Illustration.SEARCH,
            title = stringResource(R.string.search_nothing, state.query.trim()),
            message = stringResource(R.string.search_nothing_message),
            actionLabel = stringResource(R.string.people_clear_search),
            onAction = actions::onClear,
            modifier = modifier
        )
        return
    }
    val listState = rememberLazyListState()
    LazyColumn(
        modifier = modifier.fillMaxSize().imeNestedScroll().testTag("search-results"),
        state = listState,
        contentPadding = contentPadding
    ) {
        if (state.isEmptyQuery) {
            recents(state, actions)
            return@LazyColumn
        }
        if (state.people.isNotEmpty()) {
            sectionHeader("people", R.string.search_people)
            itemsIndexed(state.people, key = { _, m -> "p-${m.person.id}" }) { index, match ->
                PersonRow(
                    match.person,
                    onClick = { actions.onOpenPerson(match.person) },
                    highlights = match.highlights,
                    modifier = stagger(index)
                )
            }
            if (state.peopleTotal > state.people.size) {
                item(key = "all-people") {
                    CentyTextButton(
                        onClick = { actions.onShowAllPeople(state.query) },
                        modifier = Modifier.padding(start = 8.dp).testTag("search-all-people")
                    ) { Text(stringResource(R.string.search_all_people, state.peopleTotal)) }
                }
            }
        }
        if (state.channels.isNotEmpty()) {
            sectionHeader("channels", R.string.search_channels)
            itemsIndexed(state.channels, key = { _, c -> "c-${c.channel.id}" }) { index, match ->
                ChannelRow(match, onClick = { actions.onOpenChannel(match.channel) }, modifier = stagger(index))
            }
        }
        sectionHeader("messages", R.string.search_messages)
        when (val messages = state.messages) {
            MessageResults.Idle -> item(key = "messages-short") { Hint(stringResource(R.string.search_messages_short)) }
            MessageResults.Loading -> item(key = "messages-loading") { MessageSkeleton() }
            is MessageResults.Failed -> item(key = "messages-failed") {
                Hint(
                    stringResource(if (messages.rateLimited) R.string.search_messages_rate_limited else R.string.search_messages_failed),
                    danger = true
                )
            }
            is MessageResults.Found -> if (messages.hits.isEmpty()) {
                item(key = "messages-none") { Hint(stringResource(R.string.search_messages_none)) }
            } else {
                itemsIndexed(messages.hits, key = { _, hit -> "m-${hit.message.id}" }) { index, hit ->
                    MessageRow(hit, onClick = { actions.onOpenMessage(hit) }, modifier = stagger(index))
                }
            }
        }
    }
}

/** Первые три строки раздела проявляются лесенкой по 30 мс; дальше и при reduce motion — без задержки. */
@Composable
private fun LazyItemScope.stagger(index: Int): Modifier {
    val reduce = LocalReduceMotion.current
    return Modifier.animateItem(
        fadeInSpec = tween(if (reduce) CentyMotion.REDUCED_CROSSFADE else 150, delayMillis = if (reduce) 0 else index.coerceAtMost(3) * 30),
        placementSpec = null,
        fadeOutSpec = tween(CentyMotion.FAST)
    )
}

private fun LazyListScope.sectionHeader(key: String, title: Int) {
    item(key = "header-$key", contentType = "header") {
        Text(
            stringResource(title),
            style = MaterialTheme.typography.labelMedium,
            color = CentyTheme.tokens.textDim,
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp)
                .semantics { heading() }
                .testTag("search-section-$key")
        )
    }
}

private fun LazyListScope.recents(state: UniversalSearchState, actions: UniversalSearchActions) {
    sectionHeader("recent", R.string.search_recent)
    if (state.recents.isEmpty()) {
        item(key = "recent-empty") { Hint(stringResource(R.string.search_recent_empty)) }
        return
    }
    itemsIndexed(state.recents, key = { _, r -> "r-${r.kind}-${r.id}" }) { _, recent ->
        val tokens = CentyTheme.tokens
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .clickable(role = Role.Button) { actions.onOpenRecent(recent) }
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CentyAvatar(
                recent.title,
                avatarUrl = recent.avatarUrl,
                size = 40.dp,
                isChannel = recent.kind == RecentItem.Kind.CHANNEL
            )
            Spacer(Modifier.width(12.dp))
            Text(recent.title, style = MaterialTheme.typography.titleMedium, color = tokens.textStrong, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun ChannelRow(match: ChannelMatch, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        CentyAvatar(match.channel.name, size = 40.dp, isChannel = true)
        Spacer(Modifier.width(12.dp))
        Text(
            highlighted(match.channel.name, match.highlights, tokens.accentText),
            style = MaterialTheme.typography.titleMedium,
            color = tokens.textStrong,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/** Найденное сообщение: отправитель (и где), время, два ряда текста с подсветкой. */
@Composable
private fun MessageRow(hit: MessageHit, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    val sender = if (hit.isOwn) stringResource(R.string.search_message_from_you) else hit.senderName
    val where = when {
        hit.conversationType == ConversationType.CHANNEL && hit.conversationTitle.isNotBlank() -> "#" + hit.conversationTitle
        hit.isOwn && hit.conversationTitle.isNotBlank() -> hit.conversationTitle
        else -> null
    }
    Row(
        modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .testTag("search-message-${hit.message.id}"),
        verticalAlignment = Alignment.Top
    ) {
        if (hit.conversationType == ConversationType.CHANNEL) {
            CentyAvatar(hit.conversationTitle.ifBlank { "#" }, size = 40.dp, isChannel = true)
        } else {
            CentyAvatar(hit.conversationTitle.ifBlank { sender }, avatarUrl = hit.message.senderAvatar.takeIf { !hit.isOwn }, size = 40.dp)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (where != null) stringResource(R.string.search_message_in, sender, where) else sender,
                    style = MaterialTheme.typography.titleSmall,
                    color = tokens.textStrong,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                Spacer(Modifier.width(8.dp))
                Text(DateTimeUtils.formatDateTime(hit.message.createdAt), style = MaterialTheme.typography.labelSmall, color = tokens.textDim)
            }
            Text(
                highlighted(hit.snippet, hit.highlights, tokens.accentText),
                style = MaterialTheme.typography.bodyMedium,
                color = tokens.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

/** Две строки-заготовки под локальной выдачей, пока сервер ищет сообщения. */
@Composable
private fun MessageSkeleton() {
    SkeletonContainer(Modifier.fillMaxWidth().testTag("search-messages-loading")) {
        Column {
            repeat(2) { index ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
                    SkeletonBlock(Modifier.padding(end = 12.dp).width(40.dp).heightIn(min = 40.dp), androidx.compose.foundation.shape.CircleShape)
                    Column(Modifier.weight(1f)) {
                        SkeletonBlock(Modifier.fillMaxWidth(if (index == 0) 0.45f else 0.35f).heightIn(min = 14.dp))
                        Spacer(Modifier.width(6.dp).heightIn(min = 6.dp))
                        SkeletonBlock(Modifier.fillMaxWidth(0.9f).heightIn(min = 12.dp))
                        Spacer(Modifier.heightIn(min = 4.dp))
                        SkeletonBlock(Modifier.fillMaxWidth(0.6f).heightIn(min = 12.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun Hint(text: String, danger: Boolean = false) {
    val tokens = CentyTheme.tokens
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = if (danger) tokens.dangerText else tokens.textDim,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
    )
}
