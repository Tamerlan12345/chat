package com.openmychat.mobile.core.network

object RefreshFailurePolicy {
    fun shouldClearSession(statusCode: Int): Boolean = statusCode == 401 || statusCode == 403
}
