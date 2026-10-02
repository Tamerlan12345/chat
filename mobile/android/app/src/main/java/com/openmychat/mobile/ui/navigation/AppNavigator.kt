package com.openmychat.mobile.ui.navigation

/**
 * The only writer of [AppNavigationState]. Screens report navigation intents; the navigator
 * enforces the app's rules (one entry per tab root, no duplicate chats or calls, logout clears
 * everything).
 */
class AppNavigator(val state: AppNavigationState) {

    val hasActiveCall: Boolean
        get() = !state.isAuthFlow && state.topLevelBackStacks.values.any { stack -> stack.any { it is NavKey.Call } }

    fun navigate(key: NavKey) {
        when {
            key.isAuthDestination -> navigateWithinAuthFlow(key)
            state.isAuthFlow -> {
                // Leaving the sign-in flow is only possible towards a top-level destination.
                if (key in state.topLevelBackStacks) onAuthenticated(selectedTab = key)
            }
            key in state.topLevelBackStacks -> selectTab(key)
            key is NavKey.Chat -> openChat(key)
            key is NavKey.Call -> showCall(key)
            else -> pushUnlessOnTop(key)
        }
    }

    /** Handles a back gesture. Returns false when there is nothing left to pop (the app may finish). */
    fun goBack(): Boolean {
        val stack = state.currentBackStack
        return when {
            stack.size > 1 -> {
                stack.removeAt(stack.lastIndex)
                true
            }
            !state.isAuthFlow && state.topLevelRoute != state.startRoute -> {
                state.topLevelRoute = state.startRoute
                true
            }
            else -> false
        }
    }

    /** Shows an incoming call unless another call is already open (the caller should reject it). */
    fun showIncomingCall(call: NavKey.Call): Boolean {
        if (state.isAuthFlow || hasActiveCall) return false
        state.currentBackStack.add(call)
        return true
    }

    /** Removes the given call entry, wherever it is. */
    fun closeCall(call: NavKey.Call) {
        state.topLevelBackStacks.values.forEach { stack -> stack.removeAll { it == call } }
    }

    /**
     * Drops every protected entry, including the tab roots, so all their ViewModels are cleared, and
     * shows the sign-in flow. Top-level stacks stay empty until the next sign-in.
     */
    fun onLoggedOut(hasConfiguredServer: Boolean) {
        state.topLevelBackStacks.values.forEach { it.clear() }
        state.topLevelRoute = state.startRoute
        state.authBackStack.resetTo(if (hasConfiguredServer) NavKey.Login else NavKey.ServerConnect)
    }

    /** Aligns a restored state with the current session (e.g. after process death). */
    fun syncWithSession(session: AuthenticatedRouteState, hasConfiguredServer: Boolean) {
        val authenticated = SessionRouteGuard.hasAuthenticatedSession(session)
        when {
            !authenticated && !state.isAuthFlow -> onLoggedOut(hasConfiguredServer)
            authenticated && state.isAuthFlow -> onAuthenticated(selectedTab = state.startRoute)
        }
    }

    private fun onAuthenticated(selectedTab: NavKey) {
        state.topLevelBackStacks.forEach { (root, stack) -> stack.resetTo(root) }
        state.topLevelRoute = selectedTab
        state.authBackStack.clear()
    }

    private fun navigateWithinAuthFlow(key: NavKey) {
        if (!state.isAuthFlow) return // Signing out goes through onLoggedOut so stacks are cleared.
        val stack = state.authBackStack
        val existing = stack.indexOf(key)
        if (existing >= 0) {
            while (stack.lastIndex > existing) stack.removeAt(stack.lastIndex)
        } else {
            stack.add(key)
        }
    }

    private fun selectTab(tab: NavKey) {
        if (state.topLevelRoute == tab) {
            // Reselecting the current tab returns to its root.
            state.topLevelBackStacks.getValue(tab).resetTo(tab)
        } else {
            state.topLevelRoute = tab
        }
    }

    private fun openChat(chat: NavKey.Chat) {
        val stack = state.currentBackStack
        val top = stack.last()
        when {
            top is NavKey.Chat && top.isSameConversation(chat) -> Unit
            // Only one conversation is open at a time; on wide screens it replaces the detail pane.
            top is NavKey.Chat -> stack[stack.lastIndex] = chat
            else -> stack.add(chat)
        }
    }

    private fun showCall(call: NavKey.Call) {
        if (hasActiveCall) return
        state.currentBackStack.add(call)
    }

    private fun pushUnlessOnTop(key: NavKey) {
        val stack = state.currentBackStack
        if (stack.last() != key) stack.add(key)
    }

    private fun MutableList<NavKey>.resetTo(root: NavKey) {
        if (size == 1 && first() == root) return
        clear()
        add(root)
    }
}
