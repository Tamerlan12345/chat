package com.openmychat.mobile.ui.navigation

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import com.openmychat.mobile.core.audio.AudioEngine
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WebSocketClient
import com.openmychat.mobile.core.session.SessionManager
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
    apiClient: ApiClient,
    webSocketClient: WebSocketClient,
    sessionManager: SessionManager,
    audioEngine: AudioEngine,
    modifier: Modifier = Modifier
) {
    val token by sessionManager.tokenFlow.collectAsState()
    val currentUser by sessionManager.currentUserFlow.collectAsState()
    val storageState by sessionManager.storageState.collectAsState()
    val session = AuthenticatedRouteState(
        token = token,
        hasCurrentUser = currentUser != null,
        storageState = storageState
    )
    val requestedDestination = backStack.currentKey
    val destination = SessionRouteGuard.destinationForNavigation(
        requestedDestination = requestedDestination,
        session = session,
        hasConfiguredServer = sessionManager.serverUrl.isNotBlank()
    )

    // Do not render a protected destination from a restored/saved stack even for one frame.
    LaunchedEffect(requestedDestination, destination) {
        if (destination != requestedDestination) {
            backStack.clearAndSet(destination)
        }
    }

    fun navigate(destination: NavKey) {
        val freshSession = AuthenticatedRouteState(
            token = sessionManager.token,
            hasCurrentUser = sessionManager.currentUser != null,
            storageState = sessionManager.storageState.value
        )
        val allowedDestination = SessionRouteGuard.destinationForNavigation(
            requestedDestination = destination,
            session = freshSession,
            hasConfiguredServer = sessionManager.serverUrl.isNotBlank()
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
                val vm = viewModel { ServerConnectViewModel(apiClient, sessionManager) }
                ServerConnectScreen(
                    viewModel = vm,
                    onNavigateToLogin = { navigate(NavKey.Login) },
                    onNavigateToMain = { navigate(NavKey.Conversations) }
                )
            }
            is NavKey.Login -> {
                val vm = viewModel { LoginViewModel(apiClient, sessionManager) }
                ServerConnectScreenNavigationWrapper(
                    viewModel = vm,
                    onLoginSuccess = { navigate(NavKey.Conversations) },
                    onNavigateBackToServerConnect = { navigate(NavKey.ServerConnect) }
                )
            }
            is NavKey.Conversations -> {
                val vm = viewModel { ConversationsViewModel(apiClient, webSocketClient, sessionManager) }
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
                val vm = viewModel(key = "chat_${currentDestination.conversationType}_${currentDestination.targetId}") {
                    ChatViewModel(
                        conversationType = convType,
                        targetId = currentDestination.targetId,
                        apiClient = apiClient,
                        webSocketClient = webSocketClient,
                        sessionManager = sessionManager
                    )
                }
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
                val vm = viewModel { AnnouncementsViewModel(apiClient, webSocketClient) }
                AnnouncementsScreen(
                    viewModel = vm,
                    onNavigateToConversations = { navigate(NavKey.Conversations) },
                    onNavigateToProfile = { navigate(NavKey.Profile) }
                )
            }
            is NavKey.Call -> {
                val vm = viewModel(key = "call_${currentDestination.peerId}") {
                    CallViewModel(
                        peerId = currentDestination.peerId,
                        peerName = currentDestination.peerName,
                        isIncoming = currentDestination.isIncoming,
                        webSocketClient = webSocketClient,
                        audioEngine = audioEngine
                    )
                }
                CallScreen(
                    viewModel = vm,
                    onCallFinished = { backStack.pop() }
                )
            }
            is NavKey.Profile -> {
                val vm = viewModel { ProfileViewModel(apiClient, webSocketClient, sessionManager) }
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
