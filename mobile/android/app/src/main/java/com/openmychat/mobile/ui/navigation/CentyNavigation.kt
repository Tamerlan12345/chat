package com.openmychat.mobile.ui.navigation

import androidx.annotation.StringRes
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.outlined.Groups
import androidx.navigation3.runtime.NavMetadataKey
import androidx.navigation3.runtime.metadata
import com.openmychat.mobile.features.people.PeopleScreen
import com.openmychat.mobile.features.people.Person
import com.openmychat.mobile.features.people.PersonCardActions
import com.openmychat.mobile.features.people.PersonCardScreen
import com.openmychat.mobile.features.people.PersonViewModel
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldValue
import androidx.compose.material3.adaptive.navigationsuite.rememberNavigationSuiteScaffoldState
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.IntState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.scene.Scene
import androidx.navigation3.ui.NavDisplay
import androidx.window.core.layout.WindowSizeClass
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.features.announcements.AnnouncementsScreen
import com.openmychat.mobile.features.auth.LoginScreen
import com.openmychat.mobile.features.call.CallScreen
import com.openmychat.mobile.features.call.CallViewModel
import com.openmychat.mobile.features.chat.ChatScreen
import com.openmychat.mobile.features.chat.ChatViewModel
import com.openmychat.mobile.features.conversations.ConversationsScreen
import com.openmychat.mobile.features.profile.ProfileScreen
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.components.CentySnackbarHost
import com.openmychat.mobile.ui.components.LocalSnackbarAnchor
import com.openmychat.mobile.ui.components.LocalSharedTransitionScope
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import androidx.navigation3.runtime.contains
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion

private data class TopLevelItem(val icon: ImageVector, val selectedIcon: ImageVector, @StringRes val label: Int)

private val TopLevelItems: Map<NavKey, TopLevelItem> = mapOf(
    NavKey.Conversations to TopLevelItem(Icons.AutoMirrored.Outlined.Chat, Icons.AutoMirrored.Filled.Chat, R.string.tab_chats),
    NavKey.People to TopLevelItem(Icons.Outlined.Groups, Icons.Filled.Groups, R.string.tab_people),
    NavKey.Announcements to TopLevelItem(Icons.Outlined.Campaign, Icons.Filled.Campaign, R.string.tab_announcements),
    NavKey.Profile to TopLevelItem(Icons.Outlined.AccountCircle, Icons.Filled.AccountCircle, R.string.tab_profile)
)

/**
 * Метки записей для переходов: корень вкладки (смена вкладки — кроссфейд 150 мс без сдвига, как у
 * системных вкладок) и экран с общими элементами (аватар и имя летят между ними, остальное —
 * fade-through).
 */
object NavMeta {
    object TabRoot : NavMetadataKey<Boolean>
    object SharedHost : NavMetadataKey<Boolean>

    fun tabRoot() = metadata { put(TabRoot, true) }
    fun sharedHost() = metadata { put(SharedHost, true) }
}

/**
 * Material shared-axis X for forward/back (system grammar). Inbox ↔ chat is the exception (UI layer
 * v2): the avatar and the name travel as shared elements while the rest fades through (out 90 ms,
 * in 210 ms after it). The same grammar covers the people flow (row → card → chat). A tab switch
 * is a 150 ms crossfade without a slide. Reduce motion: a 150 ms crossfade for everything.
 */
private fun <T : Any> sharedAxis(
    reduce: Boolean,
    forward: Boolean,
    isTabSwitch: AnimatedContentTransitionScope<Scene<T>>.() -> Boolean
): AnimatedContentTransitionScope<Scene<T>>.() -> ContentTransform = {
    if (reduce) {
        fadeIn(tween(CentyMotion.REDUCED_CROSSFADE)) togetherWith fadeOut(tween(CentyMotion.REDUCED_CROSSFADE))
    } else if (isTabSwitch()) {
        fadeIn(tween(TAB_CROSSFADE)) togetherWith fadeOut(tween(TAB_CROSSFADE))
    } else if (isInboxChatPair() || isSharedPair()) {
        fadeIn(tween(CentyMotion.SHARED - CentyMotion.FADE_THROUGH_OUT, delayMillis = CentyMotion.FADE_THROUGH_OUT, easing = CentyMotion.EaseOut)) togetherWith
            fadeOut(tween(CentyMotion.FADE_THROUGH_OUT, easing = CentyMotion.EaseOut))
    } else {
        val sign = if (forward) 1 else -1
        val enter = slideInHorizontally(tween(CentyMotion.SLOW, easing = CentyMotion.EaseOut)) { width -> sign * width / 12 } +
            fadeIn(tween(CentyMotion.BASE, delayMillis = 60))
        val exit = slideOutHorizontally(tween(CentyMotion.SLOW, easing = CentyMotion.EaseOut)) { width -> -sign * width / 12 } +
            fadeOut(tween(CentyMotion.FAST))
        enter togetherWith exit
    }
}

private const val TAB_CROSSFADE = 150

/** Оба экрана перехода несут общие элементы (список/карточка/чат). */
private fun <T : Any> AnimatedContentTransitionScope<Scene<T>>.isSharedPair(): Boolean {
    val from = initialState.entries.lastOrNull()?.metadata ?: return false
    val to = targetState.entries.lastOrNull()?.metadata ?: return false
    return from.contains(NavMeta.SharedHost) && to.contains(NavMeta.SharedHost)
}

/** Предиктивный «Назад» с корня вкладки — это смена вкладки (корень лежит на дне своего стека). */
private fun <T : Any> AnimatedContentTransitionScope<Scene<T>>.leavesTabRoot(): Boolean =
    initialState.entries.lastOrNull()?.metadata?.contains(NavMeta.TabRoot) == true

/** The conversations list and a chat on top of each other (either direction). */
private fun <T : Any> AnimatedContentTransitionScope<Scene<T>>.isInboxChatPair(): Boolean {
    val from = initialState.entries.lastOrNull()?.metadata ?: return false
    val to = targetState.entries.lastOrNull()?.metadata ?: return false
    return (from.contains(ListDetailScene.ListKey) && to.contains(ListDetailScene.DetailKey)) ||
        (from.contains(ListDetailScene.DetailKey) && to.contains(ListDetailScene.ListKey))
}

/**
 * Root of the UI: the sign-in flow, or the tabs inside a [NavigationSuiteScaffold] (bottom bar on
 * compact windows, rail on wider ones) with conversations and chat side by side when there is room.
 */
@Composable
fun CentyNavigation(
    navigator: AppNavigator,
    session: AuthenticatedRouteState,
    currentSession: () -> AuthenticatedRouteState,
    modifier: Modifier = Modifier
) {
    val state = navigator.state
    val entryProvider = remember(navigator) { appEntryProvider(navigator) }
    val entries = state.toDecoratedEntries(entryProvider)

    // A new [session] value recomposes this function; the decision itself uses the synchronous
    // snapshot, because the collected value can lag behind a sign-in that just switched the flow.
    if (!state.isAuthFlow && !SessionRouteGuard.hasAuthenticatedSession(currentSession())) {
        // Never render a protected destination without a session, not even for one frame.
        Box(modifier = modifier.fillMaxSize())
        LaunchedEffect(Unit) {
            if (!SessionRouteGuard.hasAuthenticatedSession(currentSession())) navigator.onLoggedOut()
        }
        return
    }

    val adaptiveInfo = currentWindowAdaptiveInfo()
    val isListDetail = usesListDetailPanes(adaptiveInfo.windowSizeClass)
    val isCompact = !adaptiveInfo.windowSizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND)
    val listDetailStrategy = rememberListDetailSceneStrategy<NavKey>(isListDetail)

    val reduce = LocalReduceMotion.current
    val display: @Composable () -> Unit = {
        // Inbox row → chat header: the avatar and the name are shared elements. Only on a single pane
        // (side by side both are on screen anyway) and only with motion on.
        SharedTransitionLayout {
            // Смена вкладки — без общих элементов: строка «Чатов» и строка «Сотрудников» с тем же
            // человеком не должны перелетать друг в друга.
            val sharing = !(reduce || isListDetail || navigator.lastChangeWasTabSwitch)
            CompositionLocalProvider(LocalSharedTransitionScope provides if (sharing) this else null) {
                NavDisplay(
                    entries = entries,
                    onBack = { navigator.goBack() },
                    sceneStrategies = listOf(listDetailStrategy),
                    sharedTransitionScope = this,
                    transitionSpec = sharedAxis(reduce, forward = true) { navigator.lastChangeWasTabSwitch },
                    popTransitionSpec = sharedAxis(reduce, forward = false) { navigator.lastChangeWasTabSwitch },
                    predictivePopTransitionSpec = { _ -> sharedAxis<NavKey>(reduce, forward = false) { leavesTabRoot() }(this) }
                )
            }
        }
    }

    val snackbarHost = LocalSnackbarHostState.current
    val snackbarAnchor = LocalSnackbarAnchor.current
    if (state.isAuthFlow) {
        Box(modifier = modifier.fillMaxSize()) {
            display()
            CentySnackbarHost(snackbarHost, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding())
        }
        return
    }

    val currentKey = state.currentKey
    val layoutType = when {
        currentKey is NavKey.Call -> NavigationSuiteType.None
        else -> NavigationSuiteScaffoldDefaults.calculateFromAdaptiveInfo(adaptiveInfo)
    }
    // Phones show a chat full screen: the bar slides away with the inbox→chat transition and comes
    // back with it, instead of vanishing in one frame. Medium windows keep the rail next to the pane.
    val hideBar = currentKey is NavKey.Chat && isCompact
    // Starts where the destination is (a cold start or deep link into a chat must not slide the bar away).
    val navState = rememberNavigationSuiteScaffoldState(
        initialValue = if (hideBar) NavigationSuiteScaffoldValue.Hidden else NavigationSuiteScaffoldValue.Visible
    )
    LaunchedEffect(hideBar, reduce) {
        val target = if (hideBar) NavigationSuiteScaffoldValue.Hidden else NavigationSuiteScaffoldValue.Visible
        when {
            navState.targetValue == target -> Unit
            reduce -> navState.snapTo(target)
            hideBar -> navState.hide()
            else -> navState.show()
        }
    }
    val tokens = CentyTheme.tokens
    val itemColors = NavigationSuiteDefaults.itemColors(
        navigationBarItemColors = NavigationBarItemDefaults.colors(
            selectedIconColor = tokens.accentText,
            selectedTextColor = tokens.accentText,
            indicatorColor = tokens.navIndicator,
            unselectedIconColor = tokens.textSecondary,
            unselectedTextColor = tokens.textSecondary
        ),
        navigationRailItemColors = NavigationRailItemDefaults.colors(
            selectedIconColor = tokens.accentText,
            selectedTextColor = tokens.accentText,
            indicatorColor = tokens.navIndicator,
            unselectedIconColor = tokens.textSecondary,
            unselectedTextColor = tokens.textSecondary
        )
    )

    NavigationSuiteScaffold(
        modifier = modifier,
        layoutType = layoutType,
        state = navState,
        navigationSuiteColors = NavigationSuiteDefaults.colors(
            navigationBarContainerColor = tokens.frame,
            navigationRailContainerColor = tokens.frame
        ),
        containerColor = tokens.list,
        navigationSuiteItems = {
            TopLevelRoutes.forEach { route ->
                val item = TopLevelItems.getValue(route)
                val selected = route == state.topLevelRoute
                item(
                    selected = selected,
                    onClick = { navigator.navigate(route) },
                    icon = { Icon(if (selected) item.selectedIcon else item.icon, contentDescription = null) },
                    // Font scale is capped at 1.3x for the labels (Material guidance), then shrink-to-fit on one line (see NavLabelScale).
                    label = {
                        val density = LocalDensity.current
                        CompositionLocalProvider(
                            LocalDensity provides Density(density.density, NavLabelScale.cap(density.fontScale))
                        ) {
                            Text(
                                text = stringResource(item.label),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.labelMedium,
                                autoSize = TextAutoSize.StepBased(
                                    minFontSize = NavLabelScale.MIN_SP.sp,
                                    maxFontSize = MaterialTheme.typography.labelMedium.fontSize,
                                    stepSize = 0.5.sp
                                )
                            )
                        }
                    },
                    colors = itemColors
                )
            }
        }
    ) {
        // The bottom bar pads itself for the gesture area, so the screens above consume that inset, but
        // only by the part of the bar actually on screen: while the bar slides (inbox ↔ chat) the chat
        // composer then rests on max(visible bar, gesture inset) and moves continuously. The visible
        // part is read from this area's height in the same layout pass, before the screen measures.
        val windowHeight = LocalWindowInfo.current.containerSize.height
        val barAtBottom = layoutType == NavigationSuiteType.NavigationBar
        val barVisiblePx = remember { mutableIntStateOf(0) }
        val density = LocalDensity.current
        val navInsets = WindowInsets.navigationBars
        val consumed = remember(density, navInsets) { BarInsetConsumption(density, barVisiblePx) { navInsets.getBottom(density) } }
        Box(
            Modifier
                .fillMaxSize()
                .layout { measurable, constraints ->
                    barVisiblePx.intValue = if (barAtBottom && constraints.hasBoundedHeight) (windowHeight - constraints.maxHeight).coerceAtLeast(0) else 0
                    val placeable = measurable.measure(constraints)
                    layout(placeable.width, placeable.height) { placeable.place(0, 0) }
                }
                .consumeWindowInsets(consumed)
        ) {
            CompositionLocalProvider(LocalBottomBarVisible provides { barVisiblePx.intValue }) { display() }
            CentySnackbarHost(
                snackbarHost,
                Modifier
                    .align(Alignment.BottomCenter)
                    .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
                    // Above whatever the screen pins to the bottom (the chat composer reports its height).
                    .padding(bottom = snackbarAnchor.bottom)
            )
        }
    }
}

/** Conversations and the open chat share the screen only on expanded widths (>= 840dp). */
internal fun usesListDetailPanes(windowSizeClass: WindowSizeClass): Boolean =
    windowSizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND)

private fun appEntryProvider(
    navigator: AppNavigator
): (NavKey) -> NavEntry<NavKey> = entryProvider {
    entry<NavKey.Login> {
        LoginScreen(
            viewModel = hiltViewModel(),
            onLoginSuccess = { navigator.navigate(NavKey.Conversations) }
        )
    }
    entry<NavKey.Conversations>(
        metadata = ListDetailScene.listPane() + NavMeta.tabRoot() + NavMeta.sharedHost()
    ) {
        ConversationsScreen(
            viewModel = hiltViewModel(),
            searchViewModel = hiltViewModel(),
            onOpenPerson = { person -> navigator.navigate(person.toCardKey()) },
            onOpenMessage = { hit ->
                navigator.navigate(
                    NavKey.Chat(
                        conversationType = hit.conversationType.value,
                        targetId = hit.targetId,
                        title = hit.conversationTitle.ifBlank { hit.senderName },
                        focusMessageId = hit.message.id
                    )
                )
            },
            onShowAllPeople = { navigator.openPeople() },
            onOpenDirectChat = { userId, name, avatar, status ->
                navigator.navigate(
                    NavKey.Chat(
                        conversationType = ConversationType.DIRECT.value,
                        targetId = userId,
                        title = name,
                        avatarUrl = avatar,
                        status = status
                    )
                )
            },
            onOpenChannel = { channelId, name ->
                navigator.navigate(
                    NavKey.Chat(conversationType = ConversationType.CHANNEL.value, targetId = channelId, title = name)
                )
            }
        )
    }
    entry<NavKey.People>(
        metadata = ListDetailScene.listPane() + NavMeta.tabRoot() + NavMeta.sharedHost()
    ) {
        PeopleScreen(viewModel = hiltViewModel(), onOpenPerson = { person -> navigator.navigate(person.toCardKey()) })
    }
    entry<NavKey.Person>(
        metadata = ListDetailScene.detailPane() + NavMeta.sharedHost()
    ) { key ->
        val viewModel = hiltViewModel<PersonViewModel, PersonViewModel.Factory> { factory -> factory.create(key.userId) }
        PersonCardScreen(
            viewModel = viewModel,
            placeholderName = key.name,
            placeholderAvatar = key.avatarUrl,
            placeholderStatus = key.status,
            showBackButton = LocalBackButtonVisibility.current,
            actions = object : PersonCardActions {
                override fun onBack() {
                    navigator.goBack()
                }
                override fun onWrite(person: Person) = navigator.navigate(
                    NavKey.Chat(
                        conversationType = ConversationType.DIRECT.value,
                        targetId = person.id,
                        title = person.fullName,
                        avatarUrl = person.avatarUrl,
                        status = person.status.value
                    )
                )
                override fun onCall(person: Person) =
                    navigator.navigate(NavKey.Call(peerId = person.id, peerName = person.fullName, isIncoming = false))
                override fun onOpenDepartment(person: Person) {
                    viewModel.showDepartment()
                    navigator.openPeople()
                }
                override fun onEditProfile() = navigator.navigate(NavKey.Profile)
            }
        )
    }
    entry<NavKey.Chat>(
        metadata = ListDetailScene.detailPane() + NavMeta.sharedHost()
    ) { key ->
        val conversationType =
            if (key.conversationType == ConversationType.CHANNEL.value) ConversationType.CHANNEL else ConversationType.DIRECT
        ChatScreen(
            viewModel = hiltViewModel<ChatViewModel, ChatViewModel.Factory> { factory ->
                factory.create(conversationType, key.targetId, key.focusMessageId)
            },
            title = key.title,
            avatarUrl = key.avatarUrl,
            status = key.status,
            showBackButton = LocalBackButtonVisibility.current,
            onNavigateBack = { navigator.goBack() },
            onStartCall = { peerId, peerName ->
                navigator.navigate(NavKey.Call(peerId = peerId, peerName = peerName, isIncoming = false))
            },
            onOpenCard = if (conversationType == ConversationType.DIRECT) {
                { navigator.navigate(NavKey.Person(userId = key.targetId, name = key.title, avatarUrl = key.avatarUrl, status = key.status)) }
            } else null
        )
    }
    entry<NavKey.Announcements>(metadata = NavMeta.tabRoot()) {
        AnnouncementsScreen(viewModel = hiltViewModel())
    }
    entry<NavKey.Profile>(metadata = NavMeta.tabRoot()) {
        ProfileScreen(
            viewModel = hiltViewModel(),
            onLoggedOut = { navigator.onLoggedOut() }
        )
    }
    entry<NavKey.Call> { key ->
        CallScreen(
            viewModel = hiltViewModel<CallViewModel, CallViewModel.Factory> { factory ->
                factory.create(key.peerId, key.peerName, key.isIncoming)
            },
            onCallFinished = { navigator.closeCall(key) }
        )
    }
}

private fun Person.toCardKey() = NavKey.Person(userId = id, name = fullName, avatarUrl = avatarUrl, status = status.value)

/** Consumes the gesture-bar inset by the visible part of the bottom bar ([NavBarInset]). */
private class BarInsetConsumption(
    private val density: Density,
    private val barVisiblePx: IntState,
    private val navInsetPx: () -> Int
) : PaddingValues {
    override fun calculateBottomPadding(): Dp =
        with(density) { NavBarInset.consumedBottom(navInsetPx(), barVisiblePx.intValue).toDp() }

    override fun calculateTopPadding(): Dp = 0.dp
    override fun calculateLeftPadding(layoutDirection: LayoutDirection): Dp = 0.dp
    override fun calculateRightPadding(layoutDirection: LayoutDirection): Dp = 0.dp
}
