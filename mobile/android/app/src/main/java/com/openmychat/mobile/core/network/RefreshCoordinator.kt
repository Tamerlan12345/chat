package com.openmychat.mobile.core.network

class RefreshCoordinator {
    private val monitor = Any()

    private companion object { const val PROACTIVE_REFRESH_WINDOW_SECONDS = 30 * 60L }

    /**
     * A token for a request refused with [requestToken]: the current one when another request has
     * renewed the session meanwhile (and [mayUseCurrent] accepts it — the same account), otherwise a
     * fresh one from [refresh]. Null when there is none.
     */
    fun refreshIfNeeded(
        requestToken: String?,
        currentToken: () -> String?,
        refresh: (String) -> String?,
        updateToken: (String) -> Unit,
        mayUseCurrent: (String) -> Boolean = { true }
    ): String? = synchronized(monitor) {
        val activeToken = currentToken() ?: return@synchronized null
        if (!requestToken.isNullOrBlank() && requestToken != activeToken) {
            activeToken.takeIf(mayUseCurrent)
        } else {
            refresh(activeToken)?.also(updateToken)
        }
    }

    fun refreshIfExpiring(
        requestToken: String,
        expiresAtEpochSeconds: Long,
        nowEpochSeconds: Long,
        currentToken: () -> String?,
        refresh: (String) -> String?,
        updateToken: (String) -> Unit
    ): String? {
        if (expiresAtEpochSeconds - nowEpochSeconds > PROACTIVE_REFRESH_WINDOW_SECONDS) return null

        return refreshIfNeeded(
            requestToken = requestToken,
            currentToken = currentToken,
            refresh = refresh,
            updateToken = updateToken
        )
    }
}
