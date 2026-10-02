package com.openmychat.mobile.ui.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Campaign
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.ui.NavDisplay
import androidx.window.core.layout.WindowSizeClass
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.features.announcements.AnnouncementsScreen
import com.openmychat.mobile.features.auth.LoginScreen
import com.openmychat.mobile.features.call.CallScreen
import com.openmychat.mobile.features.call.CallViewModel
import com.openmychat.mobile.features.chat.ChatScreen
import com.openmychat.mobile.features.chat.ChatViewModel
import com.openmychat.mobile.features.connect.ServerConnectScreen
import com.openmychat.mobile.features.conversations.ConversationsScreen
import com.openmychat.mobile.features.profile.ProfileScreen

private data class TopLevelItem(val icon: ImageVector, val label: String)

private val TopLevelItems: Map<NavKey, TopLevelItem> = mapOf(
    NavKey.Conversations to TopLevelItem(Icons.AutoMirrored.Filled.Chat, "Сообщения"),
    NavKey.Announcements to TopLevelItem(Icons.Default.Campaign, "Объявления"),
    NavKey.Profile to TopLevelItem(Icons.Default.AccountCircle, "Профиль")
)

/**
 * Root of the UI: the sign-in flow, or the tabs inside a [NavigationSuiteScaffold] (bottom bar on
 * compact windows, rail on wider ones) with conversations and chat side by side when there is room.
 */
@Composable
fun CentyNavigation(
    navigator: AppNavigator,
    session: AuthenticatedRouteState,
    currentSession: () -> AuthenticatedRouteState,
    hasConfiguredServer: () -> Boolean,
    modifier: Modifier = Modifier
) {
    val state = navigator.state
    val entryProvider = remember(navigator) { appEntryProvider(navigator, hasConfiguredServer) }
    val entries = state.toDecoratedEntries(entryProvider)

    // [session] only triggers recomposition; the decision uses the synchronous snapshot, because the
    // collected value can lag behind a sign-in that has just switched the navigator to the main flow.
    @Suppress("UNUSED_EXPRESSION") session
    if (!state.isAuthFlow && !SessionRouteGuard.hasAuthenticatedSession(currentSession())) {
        // Never render a protected destination without a session, not even for one frame.
        Box(modifier = modifier.fillMaxSize())
        LaunchedEffect(Unit) {
            if (!SessionRouteGuard.hasAuthenticatedSession(currentSession())) navigator.onLoggedOut(hasConfiguredServer())
        }
        return
    }

    val adaptiveInfo = currentWindowAdaptiveInfo()
    val isWideWindow = adaptiveInfo.windowSizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND)
    val listDetailStrategy = rememberListDetailSceneStrategy<NavKey>(isWideWindow)

    val display: @Composable () -> Unit = {
        NavDisplay(
            entries = entries,
            onBack = { navigator.goBack() },
            sceneStrategies = listOf(listDetailStrategy)
        )
    }

    if (state.isAuthFlow) {
        Box(modifier = modifier.fillMaxSize()) { display() }
        return
    }

    val currentKey = state.currentKey
    val layoutType = when {
        currentKey is NavKey.Call -> NavigationSuiteType.None
        currentKey is NavKey.Chat && !isWideWindow -> NavigationSuiteType.None
        else -> NavigationSuiteScaffoldDefaults.calculateFromAdaptiveInfo(adaptiveInfo)
    }
    val colors = MaterialTheme.colorScheme
    val itemColors = NavigationSuiteDefaults.itemColors(
        navigationBarItemColors = NavigationBarItemDefaults.colors(
            selectedIconColor = colors.onPrimaryContainer,
            selectedTextColor = colors.primary,
            indicatorColor = colors.primaryContainer,
            unselectedIconColor = colors.onSurfaceVariant,
            unselectedTextColor = colors.onSurfaceVariant
        ),
        navigationRailItemColors = NavigationRailItemDefaults.colors(
            selectedIconColor = colors.onPrimaryContainer,
            selectedTextColor = colors.primary,
            indicatorColor = colors.primaryContainer,
            unselectedIconColor = colors.onSurfaceVariant,
            unselectedTextColor = colors.onSurfaceVariant
        )
    )

    NavigationSuiteScaffold(
        modifier = modifier,
        layoutType = layoutType,
        navigationSuiteColors = NavigationSuiteDefaults.colors(
            navigationBarContainerColor = colors.surfaceVariant.copy(alpha = 0.7f)
        ),
        navigationSuiteItems = {
            TopLevelRoutes.forEach { route ->
                val item = TopLevelItems.getValue(route)
                item(
                    selected = route == state.topLevelRoute,
                    onClick = { navigator.navigate(route) },
                    icon = { Icon(item.icon, contentDescription = null) },
                    label = { Text(item.label) },
                    colors = itemColors
                )
            }
        }
    ) {
        display()
    }
}

private fun appEntryProvider(
    navigator: AppNavigator,
    hasConfiguredServer: () -> Boolean
): (NavKey) -> NavEntry<NavKey> = entryProvider {
    entry<NavKey.ServerConnect> {
        ServerConnectScreen(
            viewModel = hiltViewModel(),
            onNavigateToLogin = { navigator.navigate(NavKey.Login) },
            onNavigateToMain = { navigator.navigate(NavKey.Conversations) }
        )
    }
    entry<NavKey.Login> {
        LoginScreen(
            viewModel = hiltViewModel(),
            onLoginSuccess = { navigator.navigate(NavKey.Conversations) },
            onNavigateBackToServerConnect = { navigator.navigate(NavKey.ServerConnect) }
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
            onLoggedOut = { navigator.onLoggedOut(hasConfiguredServer()) }
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
