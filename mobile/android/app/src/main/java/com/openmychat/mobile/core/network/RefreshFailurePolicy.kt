package com.openmychat.mobile.core.network

object RefreshFailurePolicy {
    private val invalidCredentialCodes = setOf(
        "INVALID_TOKEN",
        "TOKEN_EXPIRED",
        "TOKEN_REVOKED"
    )

    fun shouldClearSession(statusCode: Int, errorCode: String?): Boolean =
        statusCode == 401 && errorCode in invalidCredentialCodes
}
