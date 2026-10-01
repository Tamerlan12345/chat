package com.openmychat.mobile.ui.navigation

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.runtime.Composable
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
    BackHandler(enabled = backStack.stack.size > 1) {
        backStack.pop()
    }

    AnimatedContent(
        targetState = backStack.currentKey,
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
                    onNavigateToLogin = { backStack.navigate(NavKey.Login) },
                    onNavigateToMain = { backStack.clearAndSet(NavKey.Conversations) }
                )
            }
            is NavKey.Login -> {
                val vm = viewModel { LoginViewModel(apiClient, sessionManager) }
                ServerConnectScreenNavigationWrapper(
                    backStack = backStack,
                    viewModel = vm
                )
            }
            is NavKey.Conversations -> {
                val vm = viewModel { ConversationsViewModel(apiClient, webSocketClient, sessionManager) }
                ConversationsScreen(
                    viewModel = vm,
                    onOpenDirectChat = { userId, name, avatar, status ->
                        backStack.navigate(
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
                        backStack.navigate(
                            NavKey.Chat(
                                conversationType = "channel",
                                targetId = chId,
                                title = name
                            )
                        )
                    },
                    onNavigateToAnnouncements = { backStack.navigate(NavKey.Announcements) },
                    onNavigateToProfile = { backStack.navigate(NavKey.Profile) }
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
                        backStack.navigate(
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
                    onNavigateToConversations = { backStack.navigate(NavKey.Conversations) },
                    onNavigateToProfile = { backStack.navigate(NavKey.Profile) }
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
                    onNavigateToConversations = { backStack.navigate(NavKey.Conversations) },
                    onNavigateToAnnouncements = { backStack.navigate(NavKey.Announcements) },
                    onLoggedOut = { backStack.clearAndSet(NavKey.Login) }
                )
            }
        }
    }
}

@Composable
private fun ServerConnectScreenNavigationWrapper(
    backStack: NavBackStack,
    viewModel: LoginViewModel
) {
    LoginScreen(
        viewModel = viewModel,
        onLoginSuccess = { backStack.clearAndSet(NavKey.Conversations) },
        onNavigateBackToServerConnect = { backStack.navigate(NavKey.ServerConnect) }
    )
}
