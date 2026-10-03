package com.openmychat.mobile.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSerializable
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.rememberDecoratedNavEntries
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.runtime.serialization.NavBackStackSerializer
import androidx.savedstate.compose.serialization.serializers.MutableStateSerializer

/**
 * Navigation state of the whole app.
 *
 * - [authBackStack] holds the sign-in flow (login; the server is fixed at build time). It is non-empty exactly while the
 *   user is signed out, and is the only stack shown then.
 * - [topLevelBackStacks] hold one independent stack per navigation-bar destination. The start tab
 *   (Conversations) is always shown below the selected tab, so the app is exited through it. They
 *   are empty while signed out.
 */
class AppNavigationState(
    val authBackStack: NavBackStack<NavKey>,
    val topLevelBackStacks: Map<NavKey, NavBackStack<NavKey>>,
    topLevelRoute: MutableState<NavKey>
) {
    val startRoute: NavKey = NavKey.Conversations

    var topLevelRoute: NavKey by topLevelRoute

    val isAuthFlow: Boolean get() = authBackStack.isNotEmpty()

    val currentBackStack: NavBackStack<NavKey>
        get() = if (isAuthFlow) authBackStack else topLevelBackStacks.getValue(topLevelRoute)

    val currentKey: NavKey get() = currentBackStack.last()

    /** Stacks whose entries are currently on screen, bottom first. */
    val stacksInUse: List<NavBackStack<NavKey>>
        get() = when {
            isAuthFlow -> listOf(authBackStack)
            topLevelRoute == startRoute -> listOf(topLevelBackStacks.getValue(startRoute))
            else -> listOf(topLevelBackStacks.getValue(startRoute), topLevelBackStacks.getValue(topLevelRoute))
        }

    val visibleKeys: List<NavKey> get() = stacksInUse.flatten()

    companion object {
        fun authenticated(): AppNavigationState = AppNavigationState(
            authBackStack = NavBackStack(),
            topLevelBackStacks = TopLevelRoutes.associateWith { NavBackStack(it) },
            topLevelRoute = mutableStateOf(NavKey.Conversations)
        )

        /** First launch and every signed-out start: straight to login. */
        fun signedOut(): AppNavigationState = AppNavigationState(
            authBackStack = NavBackStack(NavKey.Login),
            topLevelBackStacks = TopLevelRoutes.associateWith { NavBackStack() },
            topLevelRoute = mutableStateOf(NavKey.Conversations)
        )
    }
}

/**
 * Remembers the navigation state across configuration changes and process death. [initial] is only
 * used when there is nothing to restore.
 */
@Composable
fun rememberAppNavigationState(initial: () -> AppNavigationState): AppNavigationState {
    val seed = remember { lazy(initial) }
    val stackSerializer = remember { NavBackStackSerializer(NavKey.serializer()) }
    val authBackStack = rememberSerializable(serializer = stackSerializer) { seed.value.authBackStack }
    val topLevelBackStacks = TopLevelRoutes.associateWith { route ->
        rememberSerializable(route, serializer = stackSerializer) { seed.value.topLevelBackStacks.getValue(route) }
    }
    val topLevelRoute = rememberSerializable(serializer = MutableStateSerializer(NavKey.serializer())) {
        mutableStateOf(seed.value.topLevelRoute)
    }
    return remember(authBackStack, topLevelBackStacks, topLevelRoute) {
        AppNavigationState(authBackStack, topLevelBackStacks, topLevelRoute)
    }
}

/**
 * Converts the state into decorated entries for `NavDisplay`. Every stack gets its own saveable-state
 * and ViewModel-store decorators, so state and ViewModels belong to one entry and are cleared when
 * that entry is popped, while hidden tabs keep theirs.
 */
@Composable
fun AppNavigationState.toDecoratedEntries(
    entryProvider: (NavKey) -> NavEntry<NavKey>
): List<NavEntry<NavKey>> {
    val stacks = listOf(authBackStack) + TopLevelRoutes.map { topLevelBackStacks.getValue(it) }
    val decorated = stacks.associateWith { stack ->
        rememberDecoratedNavEntries(
            backStack = stack,
            entryDecorators = listOf(
                rememberSaveableStateHolderNavEntryDecorator(),
                rememberViewModelStoreNavEntryDecorator()
            ),
            entryProvider = entryProvider
        )
    }
    return stacksInUse.flatMap { decorated.getValue(it) }
}
