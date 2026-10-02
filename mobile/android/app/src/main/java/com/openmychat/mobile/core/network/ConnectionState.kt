package com.openmychat.mobile.core.network

/** Lifecycle of the realtime connection as seen by the UI. */
sealed interface ConnectionState {
    data object Disconnected : ConnectionState
    data object Connecting : ConnectionState

    /** The socket is open and the server accepted the session token. */
    data object Connected : ConnectionState

    /**
     * The server temporarily refused the session (too many sessions, rate limited); retrying with
     * growing delays. Kept for the whole streak so the UI shows the reason once, without flicker.
     */
    data class Retrying(val code: String, val message: String) : ConnectionState

    /** The server refused the token; no reconnects until the session changes. */
    data class Unauthorized(val code: String, val message: String) : ConnectionState
}
