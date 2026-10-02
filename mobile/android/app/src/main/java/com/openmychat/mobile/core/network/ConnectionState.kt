package com.openmychat.mobile.core.network

/** Lifecycle of the realtime connection as seen by the UI. */
sealed interface ConnectionState {
    data object Disconnected : ConnectionState
    data object Connecting : ConnectionState

    /** The socket is open and the server accepted the session token. */
    data object Connected : ConnectionState

    /** The server refused the token; no reconnects until the session changes. */
    data class Unauthorized(val code: String, val message: String) : ConnectionState
}
