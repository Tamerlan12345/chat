package com.openmychat.mobile.core.network

import okhttp3.Interceptor
import okhttp3.Response

class BearerCredentialsInterceptor(
    private val tokenProvider: () -> String?,
    private val markMustChangePassword: () -> Unit
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val originalRequest = chain.request()
        val token = tokenProvider()
        val requestBuilder = originalRequest.newBuilder()
            .header("Accept", "application/json")
            .header("User-Agent", "CentyChat-Android/1.0.0")

        if (
            !token.isNullOrBlank() &&
            originalRequest.header("Authorization") == null &&
            ServerEndpointPolicy.canSendBearerCredentials(originalRequest.url)
        ) {
            requestBuilder.header("Authorization", "Bearer $token")
        }

        val response = chain.proceed(requestBuilder.build())
        if (response.code == 403 && response.peekBody(4096).string().contains("MUST_CHANGE_PASSWORD")) {
            markMustChangePassword()
        }
        return response
    }
}
