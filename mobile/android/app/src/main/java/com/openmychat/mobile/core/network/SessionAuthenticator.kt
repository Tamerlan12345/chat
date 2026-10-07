package com.openmychat.mobile.core.network

import okhttp3.Authenticator
import okhttp3.HttpUrl
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route
import java.io.IOException

/** What `POST /auth/refresh` said about the session. */
sealed interface RefreshOutcome {
    data class Renewed(val token: String) : RefreshOutcome

    /** The server refused the session (401/403): it is over. */
    data object Rejected : RefreshOutcome

    /** No definitive answer — no network, a timeout, a 5xx, an unreadable body: the session stands. */
    data object Unreachable : RefreshOutcome
}

/**
 * The refresh could not be completed for a reason that says nothing about the session (no network,
 * server error). The request fails as a network error, so nothing ends the session or drops data.
 */
class RefreshUnreachableException : IOException("Сервер не ответил на обновление сессии")

/**
 * Answers a 401 by refreshing the token once (shared by concurrent requests, [RefreshCoordinator])
 * and repeating the request with it — only ever as the account the request was sent for. A definitive refusal lets the 401 through (the session ends);
 * an unreachable refresh fails the request as a network error instead.
 */
class SessionAuthenticator(
    private val coordinator: RefreshCoordinator,
    private val currentToken: () -> String?,
    private val updateToken: (String) -> Unit,
    private val canSendCredentials: (HttpUrl) -> Boolean,
    private val refresh: (String) -> RefreshOutcome
) : Authenticator {

    override fun authenticate(route: Route?, response: Response): Request? {
        val path = response.request.url.encodedPath
        if (path.contains("/auth/refresh") || path.contains("/auth/login") || path.contains("/auth/knock")) return null
        if (responseCount(response) >= 3) return null
        if (!canSendCredentials(response.request.url)) return null

        // A request that went without a token is never answered with this session's token (it was
        // made signed out, or for nobody): it would run as an account it was not made for.
        val requestToken = response.request.header("Authorization")?.removePrefix("Bearer ")?.trim()
            ?.takeIf { it.isNotEmpty() } ?: return null
        val owner = response.request.tag(BoundCredentials::class.java)?.owner
        var unreachable = false
        val validToken = coordinator.refreshIfNeeded(
            requestToken = requestToken,
            currentToken = currentToken,
            refresh = { token ->
                when (val outcome = refresh(token)) {
                    is RefreshOutcome.Renewed -> outcome.token
                    RefreshOutcome.Rejected -> null
                    RefreshOutcome.Unreachable -> {
                        unreachable = true
                        null
                    }
                }
            },
            updateToken = updateToken,
            // Renewed by another request meanwhile: replayed only when it is the same account's
            // session (final review I4) — never another account's that signed in since.
            mayUseCurrent = { active ->
                JwtClaims.sameAccount(requestToken, active) && (owner == null || JwtClaims.userId(active) == owner)
            }
        )
        if (validToken == null) {
            if (unreachable) throw RefreshUnreachableException()
            return null
        }
        return response.request.newBuilder().header("Authorization", "Bearer $validToken").build()
    }

    private fun responseCount(response: Response): Int {
        var result = 1
        var prior = response.priorResponse
        while (prior != null) {
            result++
            prior = prior.priorResponse
        }
        return result
    }
}
