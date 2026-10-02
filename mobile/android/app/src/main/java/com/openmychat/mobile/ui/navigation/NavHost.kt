package com.openmychat.mobile.ui.navigation

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import kotlinx.coroutines.flow.Flow
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.features.announcements.AnnouncementsScreen
import com.openmychat.mobile.features.announcements.AnnouncementsViewModel
import com.openmychat.mobile.features.auth.LoginScreen
import com.openmychat.mobile.features.auth.LoginViewModel
import com.openmychat.mobile.features.call.CallScreen
import com.openmychat.mobile.features.call.CallViewModel
import com.openmychat.mobile.features.chat.ChatScreen
import com.openmychat.mobile.features.chat.ChatViewModel
import com.openmychat.mobile.features.connect.ServerConnectScreen
import com.openmychat.mobile.features.connect.ServerConnectViewModel
import com.openmychat.mobile.features.conversations.ConversationsScreen
import com.openmychat.mobile.features.conversations.ConversationsViewModel
import com.openmychat.mobile.features.profile.ProfileScreen
import com.openmychat.mobile.features.profile.ProfileViewModel

@Composable
fun CentyNavHost(
    backStack: NavBackStack,
    routeStates: Flow<AuthenticatedRouteState>,
    currentRouteState: () -> AuthenticatedRouteState,
    hasConfiguredServer: () -> Boolean,
    modifier: Modifier = Modifier
) {
    val session by routeStates.collectAsState(initial = currentRouteState())
    val requestedDestination = backStack.currentKey
    val destination = SessionRouteGuard.destinationForNavigation(
        requestedDestination = requestedDestination,
        session = session,
        hasConfiguredServer = hasConfiguredServer()
    )

    // Do not render a protected destination from a restored/saved stack even for one frame.
    LaunchedEffect(requestedDestination, destination) {
        if (destination != requestedDestination) {
            backStack.clearAndSet(destination)
        }
    }

    fun navigate(destination: NavKey) {
        val allowedDestination = SessionRouteGuard.destinationForNavigation(
            requestedDestination = destination,
            session = currentRouteState(),
            hasConfiguredServer = hasConfiguredServer()
        )
        if (allowedDestination == destination) backStack.navigate(destination)
        else backStack.clearAndSet(allowedDestination)
    }

    BackHandler(enabled = backStack.stack.size > 1) {
        backStack.pop()
    }

    AnimatedContent(
        targetState = destination,
        transitionSpec = {
            fadeIn() togetherWith fadeOut()
        },
        modifier = modifier,
        label = "NavTransition"
    ) { currentDestination ->
        when (currentDestination) {
            is NavKey.ServerConnect -> {
                val vm = hiltViewModel<ServerConnectViewModel>()
                ServerConnectScreen(
                    viewModel = vm,
                    onNavigateToLogin = { navigate(NavKey.Login) },
                    onNavigateToMain = { navigate(NavKey.Conversations) }
                )
            }
            is NavKey.Login -> {
                val vm = hiltViewModel<LoginViewModel>()
                ServerConnectScreenNavigationWrapper(
                    viewModel = vm,
                    onLoginSuccess = { navigate(NavKey.Conversations) },
                    onNavigateBackToServerConnect = { navigate(NavKey.ServerConnect) }
                )
            }
            is NavKey.Conversations -> {
                val vm = hiltViewModel<ConversationsViewModel>()
                ConversationsScreen(
                    viewModel = vm,
                    onOpenDirectChat = { userId, name, avatar, status ->
                        navigate(
                            NavKey.Chat(
                                conversationType = "direct",
                                targetId = userId,
                                title = name,
                                avatarUrl = avatar,
                                status = status
                            )
                        )
                    },
                    onOpenChannel = { chId, name ->
                        navigate(
                            NavKey.Chat(
                                conversationType = "channel",
                                targetId = chId,
                                title = name
                            )
                        )
                    },
                    onNavigateToAnnouncements = { navigate(NavKey.Announcements) },
                    onNavigateToProfile = { navigate(NavKey.Profile) }
                )
            }
            is NavKey.Chat -> {
                val convType = if (currentDestination.conversationType == "channel") ConversationType.CHANNEL else ConversationType.DIRECT
                val vm = hiltViewModel<ChatViewModel, ChatViewModel.Factory>(
                    key = "chat_${currentDestination.conversationType}_${currentDestination.targetId}"
                ) { factory -> factory.create(convType, currentDestination.targetId) }
                ChatScreen(
                    viewModel = vm,
                    title = currentDestination.title,
                    avatarUrl = currentDestination.avatarUrl,
                    status = currentDestination.status,
                    onNavigateBack = { backStack.pop() },
                    onStartCall = { peerId, peerName ->
                        navigate(
                            NavKey.Call(
                                peerId = peerId,
                                peerName = peerName,
                                isIncoming = false
                            )
                        )
                    }
                )
            }
            is NavKey.Announcements -> {
                val vm = hiltViewModel<AnnouncementsViewModel>()
                AnnouncementsScreen(
                    viewModel = vm,
                    onNavigateToConversations = { navigate(NavKey.Conversations) },
                    onNavigateToProfile = { navigate(NavKey.Profile) }
                )
            }
            is NavKey.Call -> {
                val vm = hiltViewModel<CallViewModel, CallViewModel.Factory>(
                    key = "call_${currentDestination.peerId}"
                ) { factory ->
                    factory.create(currentDestination.peerId, currentDestination.peerName, currentDestination.isIncoming)
                }
                CallScreen(
                    viewModel = vm,
                    onCallFinished = { backStack.pop() }
                )
            }
            is NavKey.Profile -> {
                val vm = hiltViewModel<ProfileViewModel>()
                ProfileScreen(
                    viewModel = vm,
                    onNavigateToConversations = { navigate(NavKey.Conversations) },
                    onNavigateToAnnouncements = { navigate(NavKey.Announcements) },
                    onLoggedOut = { navigate(NavKey.Login) }
                )
            }
        }
    }
}

@Composable
private fun ServerConnectScreenNavigationWrapper(
    viewModel: LoginViewModel,
    onLoginSuccess: () -> Unit,
    onNavigateBackToServerConnect: () -> Unit
) {
    LoginScreen(
        viewModel = viewModel,
        onLoginSuccess = onLoginSuccess,
        onNavigateBackToServerConnect = onNavigateBackToServerConnect
    )
}
