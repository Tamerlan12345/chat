package com.openmychat.mobile.core.network

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

data class ValidatedEndpoint(
    val apiBaseUrl: String,
    val webSocketUrl: String,
    val isSecure: Boolean
)

object ServerEndpointPolicy {
    fun validate(raw: String, allowInsecureDebug: Boolean): Result<ValidatedEndpoint> = runCatching {
        val endpoint = raw.trim().toHttpUrlOrNull()
            ?: throw IllegalArgumentException("Введите корректный адрес сервера")

        require(endpoint.username.isEmpty() && endpoint.password.isEmpty()) {
            "Адрес сервера не должен содержать логин и пароль"
        }
        require(endpoint.query == null && endpoint.fragment == null) {
            "Адрес сервера не должен содержать параметры запроса или фрагмент"
        }

        val secure = endpoint.scheme == "https"
        val permittedDebugHttp = endpoint.scheme == "http" && allowInsecureDebug && isLocalDebugHost(endpoint.host)
        require(secure || permittedDebugHttp) {
            "Используйте HTTPS. HTTP доступен только для явного локального отладочного адреса."
        }

        val requestedPath = endpoint.encodedPath.trimEnd('/')
        require(requestedPath.isEmpty() || requestedPath == "/api") {
            "Адрес сервера может заканчиваться только на /api"
        }

        val apiUrl = endpoint.newBuilder()
            .encodedPath("/api")
            .build()
            .toString()
            .removeSuffix("/")
        val websocketHttpUrl = endpoint.newBuilder()
            .encodedPath("/ws")
            .build()
            .toString()
            .removeSuffix("/")
        val webSocketUrl = websocketHttpUrl.replaceFirst(
            if (secure) "https://" else "http://",
            if (secure) "wss://" else "ws://"
        )

        ValidatedEndpoint(apiUrl, webSocketUrl, secure)
    }

    fun canSendBearerCredentials(url: HttpUrl, trustedApiBaseUrl: HttpUrl?): Boolean {
        if (!url.isHttps || trustedApiBaseUrl?.isHttps != true) return false

        return url.host.equals(trustedApiBaseUrl.host, ignoreCase = true) &&
            url.port == trustedApiBaseUrl.port
    }

    private fun isLocalDebugHost(host: String): Boolean = host.equals("localhost", ignoreCase = true) ||
        host == "127.0.0.1" || host == "::1" || host == "10.0.2.2" || host == "10.0.3.2"
}
