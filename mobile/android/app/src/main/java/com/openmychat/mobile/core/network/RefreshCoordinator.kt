package com.openmychat.mobile.core.network

class RefreshCoordinator {
    private val monitor = Any()

    fun refreshIfNeeded(
        requestToken: String?,
        currentToken: () -> String?,
        refresh: (String) -> String?,
        updateToken: (String) -> Unit
    ): String? = synchronized(monitor) {
        val activeToken = currentToken() ?: return@synchronized null
        if (!requestToken.isNullOrBlank() && requestToken != activeToken) {
            activeToken
        } else {
            refresh(activeToken)?.also(updateToken)
        }
    }
}
