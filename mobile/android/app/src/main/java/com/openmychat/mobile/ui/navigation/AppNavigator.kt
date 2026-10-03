package com.openmychat.mobile.ui.navigation

/**
 * The only writer of [AppNavigationState]. Screens report navigation intents; the navigator
 * enforces the app's rules (one entry per tab root, no duplicate chats or calls, logout clears
 * everything).
 */
class AppNavigator(val state: AppNavigationState) {

    val hasActiveCall: Boolean
        get() = !state.isAuthFlow && state.topLevelBackStacks.values.any { stack -> stack.any { it is NavKey.Call } }

    /**
     * Последнее изменение — смена вкладки (выбор в панели, «Назад» с корня вкладки): навигация
     * показывает её кроссфейдом без сдвига, как системные вкладки, а не как переход вглубь.
     */
    var lastChangeWasTabSwitch: Boolean = false
        private set

    fun navigate(key: NavKey) {
        lastChangeWasTabSwitch = !state.isAuthFlow && key in state.topLevelBackStacks && key != state.topLevelRoute
        when {
            key.isAuthDestination -> navigateWithinAuthFlow(key)
            state.isAuthFlow -> {
                // Leaving the sign-in flow is only possible towards a top-level destination.
                if (key in state.topLevelBackStacks) onAuthenticated(selectedTab = key)
            }
            key in state.topLevelBackStacks -> selectTab(key)
            key is NavKey.Chat -> openChat(key)
            key is NavKey.Person -> openPerson(key)
            key is NavKey.Call -> showCall(key)
            else -> pushUnlessOnTop(key)
        }
    }

    /** Handles a back gesture. Returns false when there is nothing left to pop (the app may finish). */
    fun goBack(): Boolean {
        val stack = state.currentBackStack
        lastChangeWasTabSwitch = false
        return when {
            stack.size > 1 -> {
                stack.removeAt(stack.lastIndex)
                true
            }
            !state.isAuthFlow && state.topLevelRoute != state.startRoute -> {
                state.topLevelRoute = state.startRoute
                lastChangeWasTabSwitch = true
                true
            }
            else -> false
        }
    }

    /**
     * «Сотрудники» с корня: «Все сотрудники (N)» из поиска в «Чатах», «Отдел» в карточке. Карточки,
     * открытые раньше на этой вкладке, закрываются — показывается сам справочник.
     */
    fun openPeople() {
        if (state.isAuthFlow) return
        lastChangeWasTabSwitch = state.topLevelRoute != NavKey.People
        state.topLevelBackStacks.getValue(NavKey.People).resetTo(NavKey.People)
        state.topLevelRoute = NavKey.People
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
    fun onLoggedOut() {
        state.topLevelBackStacks.values.forEach { it.clear() }
        state.topLevelRoute = state.startRoute
        state.authBackStack.resetTo(NavKey.Login)
    }

    /**
     * Aligns a restored state with the current session (e.g. after process death). Calls never
     * survive a restore: their signalling state is gone, and showing the entry again would re-send
     * call_offer or show a phantom ringing screen.
     */
    fun syncWithSession(session: AuthenticatedRouteState) {
        state.topLevelBackStacks.values.forEach { stack -> stack.removeAll { it is NavKey.Call } }
        val authenticated = SessionRouteGuard.hasAuthenticatedSession(session)
        when {
            !authenticated && !state.isAuthFlow -> onLoggedOut()
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
        val below = stack.getOrNull(stack.lastIndex - 1)
        when {
            top is NavKey.Chat && top.isSameConversation(chat) && chat.focusMessageId == null -> Unit
            // «Написать» в карточке, открытой из заголовка этого же чата, — обратно в чат.
            top is NavKey.Person && below is NavKey.Chat && below.isSameConversation(chat) && chat.focusMessageId == null ->
                stack.removeAt(stack.lastIndex)
            // Only one conversation is open at a time; on wide screens it replaces the detail pane.
            top is NavKey.Chat -> stack[stack.lastIndex] = chat
            else -> stack.add(chat)
        }
    }

    private fun openPerson(person: NavKey.Person) {
        val stack = state.currentBackStack
        val top = stack.last()
        if (top is NavKey.Person && top.userId == person.userId) return
        stack.add(person)
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
