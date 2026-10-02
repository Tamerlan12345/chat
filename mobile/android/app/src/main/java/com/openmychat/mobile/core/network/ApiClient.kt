package com.openmychat.mobile.core.network

import android.util.Base64
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

class ApiClient(
    private val sessionManager: SessionManager,
    private val okHttpClient: OkHttpClient? = null
) {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    private val refreshCoordinator = RefreshCoordinator()

    /**
     * The same client for avatar images (Coil): bearer credentials go only to the fixed HTTPS
     * server ([BearerCredentialsInterceptor]); any other host is fetched without them.
     */
    val imageHttpClient: OkHttpClient get() = client

    private val client: OkHttpClient by lazy {
        okHttpClient ?: OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .addInterceptor(BearerCredentialsInterceptor(
                tokenProvider = { sessionManager.token },
                trustedApiBaseUrlProvider = ::trustedApiBaseUrl,
                markMustChangePassword = { sessionManager.mustChangePassword = true }
            ))
            .authenticator(object : Authenticator {
                override fun authenticate(route: Route?, response: Response): Request? {
                    val path = response.request.url.encodedPath
                    if (path.contains("/auth/refresh") || path.contains("/auth/login") || path.contains("/auth/knock")) {
                        return null
                    }

                    if (responseCount(response) >= 3) {
                        return null
                    }

                    if (!canSendCurrentSessionCredentials(response.request.url)) return null

                    val requestToken = response.request.header("Authorization")
                        ?.removePrefix("Bearer ")
                        ?.trim()
                    val validToken = refreshCoordinator.refreshIfNeeded(
                        requestToken = requestToken,
                        currentToken = { sessionManager.token },
                        refresh = ::refreshTokenForAuthenticator,
                        updateToken = { refreshedToken -> sessionManager.token = refreshedToken }
                    ) ?: return null

                    return response.request.newBuilder()
                        .header("Authorization", "Bearer $validToken")
                        .build()
                }
            })
            .build()
    }

    private fun trustedApiBaseUrl(): HttpUrl? = sessionManager.serverEndpoint.apiBaseUrl.toHttpUrlOrNull()

    private fun canSendCurrentSessionCredentials(url: HttpUrl): Boolean =
        ServerEndpointPolicy.canSendBearerCredentials(url, trustedApiBaseUrl())

    private fun responseCount(response: Response): Int {
        var result = 1
        var prior = response.priorResponse
        while (prior != null) {
            result++
            prior = prior.priorResponse
        }
        return result
    }

    private fun refreshTokenForAuthenticator(currentToken: String): String? {
        val refreshUrl = "${getBaseUrl()}/auth/refresh".toHttpUrlOrNull() ?: return null
        if (!canSendCurrentSessionCredentials(refreshUrl)) return null

        return try {
            val refreshRequest = Request.Builder()
                .url(refreshUrl)
                .header("Authorization", "Bearer $currentToken")
                .header("Accept", "application/json")
                .header("User-Agent", "CentyChat-Android/1.0.0")
                .post("{}".toRequestBody(jsonMediaType))
                .build()
            val unauthenticatedClient = OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(10, TimeUnit.SECONDS)
                .build()

            unauthenticatedClient.newCall(refreshRequest).execute().use { response ->
                if (!response.isSuccessful) {
                    if (RefreshFailurePolicy.shouldClearSession(response.code)) {
                        sessionManager.clearSession()
                    }
                    return null
                }
                json.decodeFromString<RefreshResponse>(response.body?.string().orEmpty()).token
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun getBaseUrl(): String = sessionManager.serverUrl.removeSuffix("/")

    private fun checkProactiveRefresh() {
        val token = sessionManager.token ?: return
        try {
            val parts = token.split(".")
            if (parts.size >= 2) {
                val payloadJson = String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP))
                val element = json.parseToJsonElement(payloadJson).jsonObject
                val exp = element["exp"]?.jsonPrimitive?.longOrNull ?: return
                val nowSeconds = System.currentTimeMillis() / 1000
                refreshCoordinator.refreshIfExpiring(
                    requestToken = token,
                    expiresAtEpochSeconds = exp,
                    nowEpochSeconds = nowSeconds,
                    currentToken = { sessionManager.token },
                    refresh = ::refreshTokenForAuthenticator,
                    updateToken = { refreshedToken -> sessionManager.token = refreshedToken }
                )
            }
        } catch (_: Exception) {}
    }

    suspend fun checkHealth(): HealthStatus = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${getBaseUrl()}/health")
            .get()
            .build()

        executeRequest(request)
    }

    suspend fun knock(request: KnockRequest): KnockResponse = withContext(Dispatchers.IO) {
        val body = json.encodeToString(request).toRequestBody(jsonMediaType)
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/auth/knock")
            .post(body)
            .build()

        executeRequest(httpRequest)
    }

    suspend fun claimDevice(request: DeviceClaimRequest): DeviceClaimResponse = withContext(Dispatchers.IO) {
        val body = json.encodeToString(request).toRequestBody(jsonMediaType)
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/auth/device/claim")
            .post(body)
            .build()

        executeRequest(httpRequest)
    }

    suspend fun unbindDevice(request: DeviceUnbindRequest = DeviceUnbindRequest()): Unit = withContext(Dispatchers.IO) {
        val body = json.encodeToString(request).toRequestBody(jsonMediaType)
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/auth/device/unbind")
            .post(body)
            .build()

        executeRequestNoContent(httpRequest)
    }

    suspend fun login(request: LoginRequest): AuthSuccessResponse = withContext(Dispatchers.IO) {
        val body = json.encodeToString(request).toRequestBody(jsonMediaType)
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/auth/login")
            .post(body)
            .build()

        val response: AuthSuccessResponse = executeRequest(httpRequest)
        sessionManager.saveAuthSuccess(response.user, response.token)
        response
    }

    suspend fun refreshToken(): RefreshResponse = withContext(Dispatchers.IO) {
        try {
            val httpRequest = Request.Builder()
                .url("${getBaseUrl()}/auth/refresh")
                .post("{}".toRequestBody(jsonMediaType))
                .build()

            val response: RefreshResponse = executeRequest(httpRequest)
            sessionManager.token = response.token
            response
        } catch (error: ApiException) {
            if (RefreshFailurePolicy.shouldClearSession(error.statusCode)) {
                sessionManager.clearSession()
            }
            throw error
        }
    }

    suspend fun logout(): Unit = withContext(Dispatchers.IO) {
        val tokenForRemoteLogout = sessionManager.token
        if (!sessionManager.clearSession()) {
            throw SecureStorageUnavailableException()
        }

        if (tokenForRemoteLogout.isNullOrBlank()) return@withContext

        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/auth/logout")
            .header("Authorization", "Bearer $tokenForRemoteLogout")
            .post("{}".toRequestBody(jsonMediaType))
            .build()

        executeRequestNoContent(httpRequest)
    }

    suspend fun getMe(): User = withContext(Dispatchers.IO) {
        checkProactiveRefresh()
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/auth/me")
            .get()
            .build()

        val user = executeRequest<MeResponse>(httpRequest).user
        sessionManager.currentUser = user
        user
    }

    suspend fun changePassword(request: ChangePasswordRequest): ChangePasswordResponse = withContext(Dispatchers.IO) {
        val body = json.encodeToString(request).toRequestBody(jsonMediaType)
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/users/password")
            .post(body)
            .build()

        val response: ChangePasswordResponse = executeRequest(httpRequest)
        if (response.success) {
            val replacementToken = response.token?.takeIf { it.isNotBlank() }
                ?: sessionManager.token?.takeIf { it.isNotBlank() }
                ?: throw IllegalStateException("The password was changed but no authenticated session is available")
            sessionManager.replaceAuthenticatedSession(
                user = response.user,
                token = replacementToken,
                mustChangePassword = false
            )
        }
        response
    }

    suspend fun updateProfile(request: UpdateProfileRequest): User = withContext(Dispatchers.IO) {
        val body = json.encodeToString(request).toRequestBody(jsonMediaType)
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/users/profile")
            .put(body)
            .build()

        val user: User = executeRequest(httpRequest)
        sessionManager.currentUser = user
        user
    }

    suspend fun getDirectConversations(): List<DirectConversation> = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/conversations/direct")
            .get()
            .build()

        executeRequest(httpRequest)
    }

    suspend fun getChannels(): List<Channel> = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/channels")
            .get()
            .build()

        executeRequest(httpRequest)
    }

    suspend fun getDirectMessages(targetId: Long, beforeId: Long? = null, limit: Int = 50): List<Message> =
        withContext(Dispatchers.IO) {
            val urlBuilder = "${getBaseUrl()}/messages/direct/$targetId".toHttpUrlOrNull()?.newBuilder()
                ?: throw IllegalArgumentException("Invalid URL: ${getBaseUrl()}/messages/direct/$targetId")

            if (beforeId != null) urlBuilder.addQueryParameter("beforeId", beforeId.toString())
            urlBuilder.addQueryParameter("limit", limit.toString())

            val httpRequest = Request.Builder()
                .url(urlBuilder.build())
                .get()
                .build()

            executeRequest(httpRequest)
        }

    suspend fun getChannelMessages(channelId: Long, beforeId: Long? = null, limit: Int = 50): List<Message> =
        withContext(Dispatchers.IO) {
            val urlBuilder = "${getBaseUrl()}/messages/channels/$channelId".toHttpUrlOrNull()?.newBuilder()
                ?: throw IllegalArgumentException("Invalid URL: ${getBaseUrl()}/messages/channels/$channelId")

            if (beforeId != null) urlBuilder.addQueryParameter("beforeId", beforeId.toString())
            urlBuilder.addQueryParameter("limit", limit.toString())

            val httpRequest = Request.Builder()
                .url(urlBuilder.build())
                .get()
                .build()

            executeRequest(httpRequest)
        }

    suspend fun sendMessage(request: SendMessageRequest): Message = withContext(Dispatchers.IO) {
        val body = json.encodeToString(request).toRequestBody(jsonMediaType)
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/messages")
            .post(body)
            .build()

        executeRequest(httpRequest)
    }

    suspend fun getAnnouncements(): List<Announcement> = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/announcements")
            .get()
            .build()

        executeRequest(httpRequest)
    }

    suspend fun acknowledgeAnnouncement(id: Long): AnnouncementAcknowledgeResponse = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/announcements/$id/acknowledge")
            .post("{}".toRequestBody(jsonMediaType))
            .build()

        executeRequest(httpRequest)
    }

    /** Public server settings (no authentication). Has no side effects. */
    suspend fun fetchServerInfo(): ServerInfo = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/settings/info")
            .get()
            .build()

        executeRequest(httpRequest)
    }

    suspend fun getServerInfo(): ServerInfo = withContext(Dispatchers.IO) {
        val info = fetchServerInfo()
        sessionManager.messageEditWindowMinutes = info.messageEditWindowMinutes
        sessionManager.messageDeleteWindowMinutes = info.messageDeleteWindowMinutes
        info
    }

    suspend fun getFilePolicy(): FilePolicy = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/files/policy")
            .get()
            .build()

        executeRequest(httpRequest)
    }

    private inline fun <reified T> executeRequest(
        request: Request,
        requestClient: OkHttpClient = client
    ): T {
        val response = execute(requestClient, request)

        val bodyString = response.body?.string() ?: ""

        if (!response.isSuccessful) {
            handleErrorResponse(response.code, bodyString, retryAfterSeconds(response))
        }

        return try {
            json.decodeFromString<T>(bodyString)
        } catch (e: Exception) {
            throw ApiException(response.code, "SERIALIZATION_ERROR", "Ошибка парсинга ответа: ${e.message}")
        }
    }

    private fun executeRequestNoContent(request: Request) {
        val response = execute(client, request)

        if (!response.isSuccessful) {
            val bodyString = response.body?.string() ?: ""
            handleErrorResponse(response.code, bodyString, retryAfterSeconds(response))
        }
    }

    /** Transport failures: a refused certificate is reported apart from being offline. */
    private fun execute(requestClient: OkHttpClient, request: Request): Response = try {
        requestClient.newCall(request).execute()
    } catch (e: SSLException) {
        throw ApiException(0, "TLS_ERROR", e.message ?: "Ошибка защищённого соединения")
    } catch (e: IOException) {
        throw ApiException(0, "NETWORK_ERROR", e.message ?: "Ошибка сети")
    }

    /** `Retry-After` in delta-seconds (the form the server sends on 429/503); anything else is ignored. */
    private fun retryAfterSeconds(response: Response): Long? =
        response.header("Retry-After")?.trim()?.toLongOrNull()?.takeIf { it >= 0 }

    private fun handleErrorResponse(code: Int, bodyString: String, retryAfterSeconds: Long? = null): Nothing {
        var errorCode: String? = null
        var errorMessage = "HTTP error $code"

        try {
            val jsonElement = json.parseToJsonElement(bodyString).jsonObject
            errorMessage = jsonElement["error"]?.jsonPrimitive?.content
                ?: jsonElement["message"]?.jsonPrimitive?.content
                ?: errorMessage
            errorCode = jsonElement["code"]?.jsonPrimitive?.content
        } catch (_: Exception) {}

        if (code == 403 && errorCode == "MUST_CHANGE_PASSWORD") {
            sessionManager.mustChangePassword = true
            throw MustChangePasswordException(errorMessage)
        }

        if (code == 401) {
            // A protected request reached the server and the session was rejected.
            // Clear local credentials so the navigation guard can return to sign-in.
            sessionManager.clearSession()
            throw UnauthorizedException(errorMessage)
        }

        throw ApiException(code, errorCode, errorMessage, retryAfterSeconds)
    }
}
