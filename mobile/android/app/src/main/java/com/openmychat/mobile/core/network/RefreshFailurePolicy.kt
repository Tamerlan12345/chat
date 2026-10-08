package com.openmychat.mobile.core.network

object RefreshFailurePolicy {
    fun shouldClearSession(statusCode: Int): Boolean = statusCode == 401 || statusCode == 403

    /**
     * The refresh answer as the session sees it: [statusCode] null — no answer at all (network);
     * [token] — the new token of a successful answer, null when its body was unreadable. Only the
     * server refusing the session (401/403) ends it; anything else leaves it for the next try.
     */
    fun classify(statusCode: Int?, token: String?): RefreshOutcome = when {
        statusCode == null -> RefreshOutcome.Unreachable
        statusCode in 200..299 && !token.isNullOrBlank() -> RefreshOutcome.Renewed(token)
        shouldClearSession(statusCode) -> RefreshOutcome.Rejected
        else -> RefreshOutcome.Unreachable
    }
}
