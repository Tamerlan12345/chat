package com.openmychat.mobile.core.network

import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response

class BearerCredentialsInterceptor(
    private val tokenProvider: () -> String?,
    private val trustedApiBaseUrlProvider: () -> HttpUrl?,
    private val markMustChangePassword: () -> Unit
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val originalRequest = chain.request()
        val requestBuilder = originalRequest.newBuilder()
            .header("Accept", "application/json")
            .header("User-Agent", "CentyChat-Android/1.0.0")

        if (!ServerEndpointPolicy.canSendBearerCredentials(
                originalRequest.url,
                trustedApiBaseUrlProvider()
            )
        ) {
            requestBuilder.removeHeader("Authorization")
            requestBuilder.removeHeader(AvatarOptIn.HEADER)
        } else {
            // Свой сервер: фото коллег — ссылками, а не data URL в каждом ответе.
            requestBuilder.header(AvatarOptIn.HEADER, AvatarOptIn.VALUE)
            if (originalRequest.header("Authorization") == null) {
                val token = tokenFor(originalRequest)
                if (!token.isNullOrBlank()) requestBuilder.header("Authorization", "Bearer $token")
            }
        }

        val response = chain.proceed(requestBuilder.build())
        if (response.code == 403 && response.peekBody(4096).string().contains("MUST_CHANGE_PASSWORD")) {
            markMustChangePassword()
        }
        return response
    }

    /**
     * The token a request goes with. A request bound when it was made ([BoundCredentials]) goes only
     * as that account: with the current token when it is the same account's (it may have been
     * refreshed meanwhile), without one when it was made signed out, and not at all once another
     * account — or nobody — is signed in. An unbound request (images) takes the current token.
     */
    private fun tokenFor(request: Request): String? {
        val bound = request.tag(BoundCredentials::class.java) ?: return tokenProvider()
        val madeWith = bound.token ?: return null
        val current = tokenProvider()
        return when {
            current == madeWith -> current
            JwtClaims.sameAccount(current, madeWith) -> current
            else -> throw AccountChangedException()
        }
    }
}
