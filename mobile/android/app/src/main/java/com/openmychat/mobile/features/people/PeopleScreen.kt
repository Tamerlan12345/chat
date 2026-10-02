package com.openmychat.mobile.features.people

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imeNestedScroll
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.height
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.LocalContentColor
import com.openmychat.mobile.R
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.ui.components.ConnectionBanner
import com.openmychat.mobile.ui.components.CentySearchField
import com.openmychat.mobile.ui.components.EmptyState
import com.openmychat.mobile.ui.components.ErrorState
import com.openmychat.mobile.ui.components.Illustration
import com.openmychat.mobile.ui.components.InlineNotice
import com.openmychat.mobile.ui.components.PeopleSkeleton
import com.openmychat.mobile.ui.components.liftSurface
import com.openmychat.mobile.ui.components.rememberLift
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** Что умеет экран «Сотрудники»; по умолчанию — ничего (превью и тесты). */
interface PeopleActions {
    fun onQuery(query: String) {}
    fun onScope(scope: PeopleScope) {}
    fun onToggleOnline() {}
    fun onToggleDepartment(id: Long) {}
    fun onRefresh() {}
    fun onOpenPerson(person: Person) {}
}

@Composable
fun PeopleScreen(viewModel: PeopleViewModel, onOpenPerson: (Person) -> Unit) {
    val state by viewModel.state.collectAsState()
    val connection by viewModel.connectionState.collectAsState()
    val actions = remember(viewModel) {
        object : PeopleActions {
            override fun onQuery(query: String) = viewModel.setQuery(query)
            override fun onScope(scope: PeopleScope) = viewModel.setScope(scope)
            override fun onToggleOnline() = viewModel.toggleOnlineOnly()
            override fun onToggleDepartment(id: Long) = viewModel.toggleDepartment(id)
            override fun onRefresh() = viewModel.refresh()
            override fun onOpenPerson(person: Person) = onOpenPerson(person)
        }
    }
    PeopleContent(state = state, connectionState = connection, actions = actions)
}

/**
 * «Сотрудники» без состояния: верхняя панель со сводкой «48 сотрудников · 12 в сети», поле
 * поиска, «Все | Отделы» и «В сети». Фокус в поиске сворачивает сводку и переключатели (200 мс),
 * выдача сменяет список затуханием (150 мс).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PeopleContent(
    state: PeopleUiState,
    connectionState: ConnectionState,
    actions: PeopleActions,
    modifier: Modifier = Modifier
) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val focus = LocalFocusManager.current
    // Режим поиска — пока поле в фокусе или в нём есть текст: запрос из карточки («Отдел») его закрывает.
    var searchFocused by remember { mutableStateOf(false) }
    val searchActive = searchFocused || state.query.isNotEmpty()
    val focusRequester = remember { FocusRequester() }
    val allState = rememberLazyListState()
    val resultsState = rememberLazyListState()
    val treeState = rememberLazyListState()
    val listState = when {
        state.scope == PeopleScope.DEPARTMENTS -> treeState
        state.isSearching -> resultsState
        else -> allState
    }
    val scrolledUnder by remember(listState) { derivedStateOf { listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 0 } }
    val lift = rememberLift(scrolledUnder)

    BackHandler(enabled = searchActive) {
        actions.onQuery("")
        searchFocused = false
        focus.clearFocus()
    }

    val collapse = if (reduce) tween<Float>(CentyMotion.REDUCED_CROSSFADE) else tween(200, easing = CentyMotion.EaseOut)
    Scaffold(
        modifier = modifier,
        containerColor = tokens.list,
        topBar = {
            Column(Modifier.liftSurface(lift, rest = tokens.list)) {
                TopAppBar(
                    title = {
                        Column {
                            Text(stringResource(R.string.people_title), maxLines = 1)
                            AnimatedVisibility(
                                visible = !searchActive && state.isLoaded,
                                enter = fadeIn(collapse) + expandVertically(tween(200)),
                                exit = fadeOut(collapse) + shrinkVertically(tween(200))
                            ) {
                                Text(
                                    pluralStringResource(R.plurals.people_count, state.total, state.total) + " · " +
                                        stringResource(R.string.people_online_count, state.online),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = tokens.textDim,
                                    modifier = Modifier.testTag("people-summary")
                                )
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = Color.Transparent,
                        scrolledContainerColor = Color.Transparent,
                        titleContentColor = tokens.textStrong
                    )
                )
                ConnectionBanner(connectionState)
                CentySearchField(
                    query = state.query,
                    onQueryChange = actions::onQuery,
                    placeholder = stringResource(R.string.people_search_hint),
                    active = searchActive,
                    onActiveChange = { active ->
                        searchFocused = active
                        if (!active) {
                            actions.onQuery("")
                            focus.clearFocus()
                        }
                    },
                    onSearch = {
                        // Return открывает первый результат.
                        val first = state.results.firstOrNull()?.person ?: state.sections.firstOrNull()?.people?.firstOrNull()
                        if (first != null) actions.onOpenPerson(first) else focus.clearFocus()
                    },
                    focusRequester = focusRequester,
                    onFocusChange = { searchFocused = it },
                    testTag = "people-search",
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
                )
                AnimatedVisibility(
                    visible = !searchActive,
                    enter = fadeIn(collapse) + expandVertically(tween(200)),
                    exit = fadeOut(collapse) + shrinkVertically(tween(200))
                ) {
                    ScopeRow(state, actions)
                }
            }
        }
    ) { innerPadding ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(top = innerPadding.calculateTopPadding())
                .consumeWindowInsets(innerPadding)
        ) {
            val bottom = innerPadding.calculateBottomPadding()
            when {
                !state.isLoaded && !state.refreshFailed -> PeopleSkeleton(Modifier.padding(top = 4.dp))
                !state.isLoaded -> ErrorState(title = stringResource(R.string.people_error), onRetry = actions::onRefresh)
                else -> Column(Modifier.fillMaxSize()) {
                    AnimatedVisibility(visible = state.refreshFailed) {
                        InlineNotice(
                            text = stringResource(R.string.people_refresh_failed),
                            actionLabel = stringResource(R.string.action_retry),
                            onAction = actions::onRefresh,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp).testTag("people-refresh-failed")
                        )
                    }
                    val pull = rememberPullToRefreshState()
                    PullToRefreshBox(
                        isRefreshing = state.isRefreshing,
                        onRefresh = actions::onRefresh,
                        state = pull,
                        modifier = Modifier.fillMaxSize(),
                        indicator = {
                            PullToRefreshDefaults.Indicator(
                                state = pull,
                                isRefreshing = state.isRefreshing,
                                color = tokens.accentText,
                                containerColor = tokens.elevated,
                                modifier = Modifier.align(Alignment.TopCenter)
                            )
                        }
                    ) {
                        val mode = when {
                            state.isEmptyResult -> 0
                            state.scope == PeopleScope.DEPARTMENTS -> 1
                            state.isSearching -> 2
                            else -> 3
                        }
                        AnimatedContent(
                            targetState = mode,
                            transitionSpec = {
                                val spec = tween<Float>(if (reduce) CentyMotion.REDUCED_CROSSFADE else 150)
                                fadeIn(spec) togetherWith fadeOut(tween(if (reduce) CentyMotion.REDUCED_CROSSFADE else 90))
                            },
                            label = "people-body"
                        ) { shown ->
                            val padding = PaddingValues(top = 4.dp, bottom = bottom + 8.dp)
                            when (shown) {
                                0 -> EmptyResult(state, actions)
                                1 -> DepartmentTree(treeState, state, padding, actions)
                                2 -> LazyColumn(
                                    Modifier.fillMaxSize().imeNestedScroll().testTag("people-results"),
                                    state = resultsState,
                                    contentPadding = padding
                                ) {
                                    items(state.results, key = { it.person.id }) { match ->
                                        PersonRow(
                                            match.person,
                                            onClick = { actions.onOpenPerson(match.person) },
                                            highlights = match.highlights,
                                            subtitleHighlights = match.subtitleHighlights,
                                            extensionHighlights = match.extensionHighlights
                                        )
                                    }
                                }
                                else -> AlphabetList(allState, state.sections, padding, actions)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ScopeRow(state: PeopleUiState, actions: PeopleActions) {
    val tokens = CentyTheme.tokens
    Row(
        Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        val colors = SegmentedButtonDefaults.colors(
            activeContainerColor = tokens.primarySoft,
            activeContentColor = tokens.accentText,
            activeBorderColor = tokens.primaryLine,
            inactiveContainerColor = tokens.card,
            inactiveContentColor = tokens.textSecondary,
            inactiveBorderColor = tokens.borderStrong
        )
        SingleChoiceSegmentedButtonRow(Modifier.weight(1f).fillMaxHeight()) {
            listOf(PeopleScope.ALL to R.string.people_scope_all, PeopleScope.DEPARTMENTS to R.string.people_scope_departments)
                .forEachIndexed { index, (scope, label) ->
                    SegmentedButton(
                        selected = state.scope == scope,
                        onClick = { actions.onScope(scope) },
                        shape = SegmentedButtonDefaults.itemShape(index, 2, RoundedCornerShape(CentyRadius.control)),
                        colors = colors,
                        icon = {},
                        // Сжимается, а не обрезается при крупном шрифте («Отделы» при 2.0).
                        label = {
                            BasicText(
                                stringResource(label),
                                maxLines = 1,
                                style = MaterialTheme.typography.labelLarge.copy(color = LocalContentColor.current),
                                autoSize = TextAutoSize.StepBased(minFontSize = 10.sp, maxFontSize = MaterialTheme.typography.labelLarge.fontSize)
                            )
                        },
                        modifier = Modifier.fillMaxHeight().heightIn(min = 48.dp).testTag("people-scope-${scope.name.lowercase()}")
                    )
                }
        }
        FilterChip(
            selected = state.onlineOnly,
            onClick = actions::onToggleOnline,
            label = { Text(stringResource(R.string.people_online_filter), maxLines = 1) },
            leadingIcon = {
                if (state.onlineOnly) {
                    Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                } else {
                    // Та же ширина, что у галочки: переключатели рядом не прыгают.
                    Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
                        Box(Modifier.size(8.dp).background(tokens.online, CircleShape))
                    }
                }
            },
            shape = RoundedCornerShape(CentyRadius.control),
            colors = FilterChipDefaults.filterChipColors(
                containerColor = tokens.card,
                labelColor = tokens.textSecondary,
                selectedContainerColor = tokens.primarySoft,
                selectedLabelColor = tokens.accentText,
                selectedLeadingIconColor = tokens.accentText
            ),
            border = FilterChipDefaults.filterChipBorder(
                enabled = true,
                selected = state.onlineOnly,
                borderColor = tokens.borderStrong,
                selectedBorderColor = tokens.primaryLine
            ),
            modifier = Modifier.fillMaxHeight().heightIn(min = 48.dp).testTag("people-online-filter")
        )
    }
}

@Composable
private fun EmptyResult(state: PeopleUiState, actions: PeopleActions) {
    when {
        state.isSearching -> EmptyState(
            illustration = Illustration.SEARCH,
            title = stringResource(R.string.people_not_found, state.query.trim()),
            message = stringResource(R.string.people_not_found_message),
            actionLabel = stringResource(R.string.people_clear_search),
            onAction = { actions.onQuery("") }
        )
        state.onlineOnly -> EmptyState(
            illustration = Illustration.SEARCH,
            title = stringResource(R.string.people_nobody_online),
            message = stringResource(R.string.people_nobody_online_message),
            actionLabel = stringResource(R.string.people_show_everyone),
            onAction = actions::onToggleOnline
        )
        else -> EmptyState(
            illustration = Illustration.INBOX,
            title = stringResource(R.string.people_empty),
            message = stringResource(R.string.people_empty_message),
            actionLabel = stringResource(R.string.action_refresh),
            onAction = actions::onRefresh
        )
    }
}

/** «Все»: разделы А–Я с липкими буквами и полоса быстрой прокрутки с пузырём буквы. */
@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
private fun AlphabetList(listState: LazyListState, sections: List<LetterSection>, padding: PaddingValues, actions: PeopleActions) {
    val tokens = CentyTheme.tokens
    // Индекс первой строки каждого раздела (заголовок буквы — тоже строка списка).
    val starts = remember(sections) {
        var index = 0
        sections.map { section -> (section.letter to index).also { index += section.people.size + 1 } }
    }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize().imeNestedScroll().testTag("people-list"),
            state = listState,
            contentPadding = padding
        ) {
            sections.forEach { section ->
                stickyHeader(key = "letter-${section.letter}", contentType = "letter") {
                    Text(
                        section.letter,
                        style = MaterialTheme.typography.labelMedium,
                        color = tokens.textDim,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(tokens.list)
                            .padding(horizontal = 16.dp, vertical = 6.dp)
                            .semantics { heading() }
                    )
                }
                items(section.people, key = { it.id }, contentType = { "person" }) { person ->
                    PersonRow(person, onClick = { actions.onOpenPerson(person) })
                }
            }
        }
        if (sections.sumOf { it.people.size } > FAST_SCROLL_MIN) {
            FastScroller(listState, starts, Modifier.align(Alignment.CenterEnd))
        }
    }
}

private const val FAST_SCROLL_MIN = 12

/**
 * Быстрая прокрутка у правого края: ухватить бегунок (появляется, пока список движется) и тянуть —
 * список едет к букве, рядом пузырь с ней. Касание принимает только сам бегунок с запасом под
 * палец: обычная прокрутка у края экрана к букве не прыгает. Для TalkBack полоса скрыта — список
 * целиком доступен обычной прокруткой, буквы разделов остаются заголовками.
 */
@Composable
private fun FastScroller(listState: LazyListState, starts: List<Pair<String, Int>>, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    val scope = rememberCoroutineScope()
    var dragging by remember { mutableStateOf(false) }
    var fraction by remember { mutableStateOf(0f) }
    val total = listState.layoutInfo.totalItemsCount.coerceAtLeast(1)
    val shownFraction = if (dragging) fraction else listState.firstVisibleItemIndex.toFloat() / total
    val letter = starts.lastOrNull { it.second <= (shownFraction * total).roundToInt() }?.first ?: starts.firstOrNull()?.first.orEmpty()
    val visible = dragging || listState.isScrollInProgress
    val alpha by animateFloatAsState(if (visible) 1f else 0f, CentyMotion.base(), label = "fast-scroll")

    BoxWithConstraints(modifier.fillMaxHeight().padding(vertical = 8.dp).width(48.dp).clearAndSetSemantics { }) {
        val trackPx = constraints.maxHeight.toFloat().coerceAtLeast(1f)
        val thumbHeight = 40.dp
        val thumbPx = with(LocalDensity.current) { thumbHeight.toPx() }
        fun moveTo(f: Float) {
            fraction = f.coerceIn(0f, 1f)
            val target = starts.lastOrNull { it.second <= (fraction * total).roundToInt() }?.second ?: 0
            scope.launch { listState.scrollToItem(target) }
        }
        val y = ((trackPx - thumbPx) * shownFraction.coerceIn(0f, 1f)).roundToInt()
        // Зона касания — только бегунок (48 × 64 dp вокруг него), и только пока он виден.
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .offset { IntOffset(0, (y - 12.dp.roundToPx()).coerceAtLeast(0)) }
                .size(width = 48.dp, height = thumbHeight + 24.dp)
                .then(
                    if (alpha > 0f || dragging) {
                        Modifier.pointerInput(starts, trackPx) {
                            detectVerticalDragGestures(
                                onDragStart = {
                                    fraction = shownFraction
                                    dragging = true
                                },
                                onDragEnd = { dragging = false },
                                onDragCancel = { dragging = false },
                                onVerticalDrag = { change, dy ->
                                    change.consume()
                                    moveTo(fraction + dy / (trackPx - thumbPx).coerceAtLeast(1f))
                                }
                            )
                        }
                    } else Modifier
                )
        ) {
            Box(
                Modifier
                    .align(Alignment.Center)
                    .padding(start = 40.dp)
                    .size(width = 4.dp, height = thumbHeight)
                    .background(tokens.textDim.copy(alpha = 0.6f * alpha), RoundedCornerShape(2.dp))
            )
        }
        if (dragging && letter.isNotEmpty()) {
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .offset { IntOffset(-56.dp.roundToPx(), (y - 8.dp.roundToPx()).coerceAtLeast(0)) }
                    .size(56.dp)
                    .background(tokens.primary, CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Text(letter, style = MaterialTheme.typography.headlineSmall, color = Color.White)
            }
        }
    }
}

/** Строка дерева «Отделов»: отдел или сотрудник с глубиной вложенности. */
private sealed interface TreeRow {
    val key: String

    data class Department(val node: DepartmentNode, val depth: Int, val expanded: Boolean) : TreeRow {
        override val key: String get() = "dept-${node.id}"
    }

    data class Member(val person: Person, val depth: Int, val order: Int) : TreeRow {
        override val key: String get() = "member-${person.id}"
    }
}

private fun flatten(nodes: List<DepartmentNode>, expanded: Set<Long>, depth: Int = 0, into: MutableList<TreeRow> = ArrayList()): List<TreeRow> {
    nodes.forEach { node ->
        val open = node.id in expanded
        into += TreeRow.Department(node, depth, open)
        if (open) {
            flatten(node.children, expanded, depth + 1, into)
            node.people.forEachIndexed { i, person -> into += TreeRow.Member(person, depth + 1, node.children.size + i) }
        }
    }
    return into
}

/** «Отделы»: дерево с раскрытием (поворот треугольника 180 мс, дети проявляются лесенкой до 6 × 20 мс). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DepartmentTree(listState: LazyListState, state: PeopleUiState, padding: PaddingValues, actions: PeopleActions) {
    val reduce = LocalReduceMotion.current
    val rows = remember(state.departments, state.expanded) { flatten(state.departments, state.expanded) }
    LazyColumn(Modifier.fillMaxSize().imeNestedScroll().testTag("people-tree"), state = listState, contentPadding = padding) {
        items(rows, key = { it.key }, contentType = { it::class }) { row ->
            val stagger = when (row) {
                is TreeRow.Member -> row.order.coerceAtMost(6) * 20
                is TreeRow.Department -> 0
            }
            val item = Modifier.animateItem(
                fadeInSpec = if (reduce) tween(CentyMotion.REDUCED_CROSSFADE) else tween(CentyMotion.BASE, delayMillis = stagger),
                placementSpec = if (reduce) null else tween(CentyMotion.BASE, easing = CentyMotion.EaseOut),
                fadeOutSpec = tween(CentyMotion.FAST)
            )
            when (row) {
                is TreeRow.Department -> DepartmentRow(row, onToggle = { actions.onToggleDepartment(row.node.id) }, modifier = item)
                is TreeRow.Member -> PersonRow(
                    row.person,
                    onClick = { actions.onOpenPerson(row.person) },
                    indent = 16.dp * row.depth,
                    modifier = item
                )
            }
        }
    }
}

@Composable
private fun DepartmentRow(row: TreeRow.Department, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val node = row.node
    val rotation by animateFloatAsState(
        targetValue = if (row.expanded) 90f else 0f,
        animationSpec = if (reduce) tween(0) else tween(180, easing = CentyMotion.EaseOut),
        label = "dept-chevron"
    )
    val name = if (node.isUnassigned) stringResource(R.string.people_unassigned) else node.name
    val stateText = stringResource(if (row.expanded) R.string.people_department_collapse else R.string.people_department_expand)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clickable(role = Role.Button, onClick = onToggle)
            .semantics(mergeDescendants = true) { stateDescription = stateText }
            .padding(start = 8.dp + 16.dp * row.depth, end = 16.dp)
            .testTag("dept-${node.id}"),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            Icons.Outlined.ChevronRight,
            contentDescription = null,
            tint = tokens.textSecondary,
            modifier = Modifier.size(24.dp).rotate(rotation)
        )
        Spacer(Modifier.width(8.dp))
        Text(
            name,
            style = MaterialTheme.typography.titleSmall,
            color = tokens.textStrong,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
        Spacer(Modifier.width(8.dp))
        val counter = stringResource(R.string.people_department_online, node.online, node.total)
        if (node.online > 0) {
            Text(
                counter,
                style = MaterialTheme.typography.labelSmall,
                color = tokens.successText,
                modifier = Modifier
                    .background(tokens.successSoft, RoundedCornerShape(50))
                    .padding(horizontal = 8.dp, vertical = 2.dp)
            )
        } else {
            Text(counter, style = MaterialTheme.typography.labelSmall, color = tokens.textDim)
        }
    }
}
