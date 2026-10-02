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
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.LocalContentColor
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
    NavKey.Announcements to TopLevelItem(Icons.Outlined.Campaign, Icons.Filled.Campaign, R.string.tab_announcements),
    NavKey.Profile to TopLevelItem(Icons.Outlined.AccountCircle, Icons.Filled.AccountCircle, R.string.tab_profile)
)

/**
 * Material shared-axis X for forward/back (system grammar). Inbox ↔ chat is the exception (UI layer
 * v2): the avatar and the name travel as shared elements while the rest fades through (out 90 ms,
 * in 210 ms after it). Reduce motion: a 150 ms crossfade for everything.
 */
private fun <T : Any> sharedAxis(reduce: Boolean, forward: Boolean): AnimatedContentTransitionScope<Scene<T>>.() -> ContentTransform = {
    if (reduce) {
        fadeIn(tween(CentyMotion.REDUCED_CROSSFADE)) togetherWith fadeOut(tween(CentyMotion.REDUCED_CROSSFADE))
    } else if (isInboxChatPair()) {
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
            CompositionLocalProvider(LocalSharedTransitionScope provides if (reduce || isListDetail) null else this) {
                NavDisplay(
                    entries = entries,
                    onBack = { navigator.goBack() },
                    sceneStrategies = listOf(listDetailStrategy),
                    sharedTransitionScope = this,
                    transitionSpec = sharedAxis(reduce, forward = true),
                    popTransitionSpec = sharedAxis(reduce, forward = false),
                    predictivePopTransitionSpec = { _ -> sharedAxis<NavKey>(reduce, forward = false)(this) }
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
        // Phones show a chat full screen; medium windows keep the rail next to the single pane.
        currentKey is NavKey.Chat && isCompact -> NavigationSuiteType.None
        else -> NavigationSuiteScaffoldDefaults.calculateFromAdaptiveInfo(adaptiveInfo)
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
                    // Shrinks instead of clipping at large font sizes («Объявления» at fontScale 2.0).
                    label = {
                        BasicText(
                            text = stringResource(item.label),
                            maxLines = 1,
                            style = MaterialTheme.typography.labelMedium.copy(color = LocalContentColor.current),
                            autoSize = TextAutoSize.StepBased(minFontSize = 8.sp, maxFontSize = MaterialTheme.typography.labelMedium.fontSize)
                        )
                    },
                    colors = itemColors
                )
            }
        }
    ) {
        // The bottom bar already pads for the gesture area; screens above it must not pad again.
        val barInsets = if (layoutType == NavigationSuiteType.NavigationBar) WindowInsets.navigationBars else WindowInsets(0, 0, 0, 0)
        Box(Modifier.fillMaxSize().consumeWindowInsets(barInsets)) {
            display()
            CentySnackbarHost(
                snackbarHost,
                Modifier
                    .align(Alignment.BottomCenter)
                    .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime).exclude(barInsets))
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
        metadata = ListDetailScene.listPane()
    ) {
        ConversationsScreen(
            viewModel = hiltViewModel(),
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
    entry<NavKey.Chat>(
        metadata = ListDetailScene.detailPane()
    ) { key ->
        val conversationType =
            if (key.conversationType == ConversationType.CHANNEL.value) ConversationType.CHANNEL else ConversationType.DIRECT
        ChatScreen(
            viewModel = hiltViewModel<ChatViewModel, ChatViewModel.Factory> { factory ->
                factory.create(conversationType, key.targetId)
            },
            title = key.title,
            avatarUrl = key.avatarUrl,
            status = key.status,
            showBackButton = LocalBackButtonVisibility.current,
            onNavigateBack = { navigator.goBack() },
            onStartCall = { peerId, peerName ->
                navigator.navigate(NavKey.Call(peerId = peerId, peerName = peerName, isIncoming = false))
            }
        )
    }
    entry<NavKey.Announcements> {
        AnnouncementsScreen(viewModel = hiltViewModel())
    }
    entry<NavKey.Profile> {
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
