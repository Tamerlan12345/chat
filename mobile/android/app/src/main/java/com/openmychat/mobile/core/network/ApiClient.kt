package com.openmychat.mobile.core.network

import android.util.Base64
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
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
            // A refresh that gets no definitive answer fails the request as a network error instead of
            // ending the session (which would also have dropped the unsent messages).
            .authenticator(SessionAuthenticator(
                coordinator = refreshCoordinator,
                currentToken = { sessionManager.token },
                updateToken = { refreshedToken -> sessionManager.token = refreshedToken },
                canSendCredentials = ::canSendCurrentSessionCredentials,
                refresh = ::refreshTokenForAuthenticator
            ))
            .build()
    }

    private fun trustedApiBaseUrl(): HttpUrl? = sessionManager.serverEndpoint.apiBaseUrl.toHttpUrlOrNull()

    private fun canSendCurrentSessionCredentials(url: HttpUrl): Boolean =
        ServerEndpointPolicy.canSendBearerCredentials(url, trustedApiBaseUrl())

    private fun refreshTokenForAuthenticator(currentToken: String): RefreshOutcome {
        val refreshUrl = "${getBaseUrl()}/auth/refresh".toHttpUrlOrNull() ?: return RefreshOutcome.Rejected
        if (!canSendCurrentSessionCredentials(refreshUrl)) return RefreshOutcome.Rejected

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
                val token = if (response.isSuccessful) {
                    runCatching { json.decodeFromString<RefreshResponse>(response.body?.string().orEmpty()).token }.getOrNull()
                } else {
                    null
                }
                RefreshFailurePolicy.classify(response.code, token).also {
                    // The refused session ends — unless another one was signed in meanwhile.
                    if (it == RefreshOutcome.Rejected) sessionManager.clearSessionIfCurrent(currentToken)
                }
            }
        } catch (_: Exception) {
            // No answer (network, TLS, timeout): nothing is known about the session — it stands.
            RefreshFailurePolicy.classify(null, null)
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
                    refresh = { current -> (refreshTokenForAuthenticator(current) as? RefreshOutcome.Renewed)?.token },
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

    // --- Self-registration, account deletion, reports and blocks (contracts/registration.md) ---

    suspend fun requestRegistration(request: RegisterRequestBody): RegistrationChallenge = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/auth/register/request")
            .post(json.encodeToString(request).toRequestBody(jsonMediaType))
            .build()

        executeRequest(httpRequest)
    }

    /** `200` is a sign-in exactly like `/auth/login` (the session is stored); `202` is a pending registration. */
    suspend fun verifyRegistration(registrationId: String, code: String): RegistrationOutcome = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/auth/register/verify")
            .post(json.encodeToString(RegisterVerifyBody(registrationId, code)).toRequestBody(jsonMediaType))
            .build()

        val answer: JsonObject = executeRequest(httpRequest)
        val token = (answer["token"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
        when {
            token != null -> {
                val user = json.decodeFromJsonElement<User>(
                    answer["user"] ?: throw ApiException(200, "SERIALIZATION_ERROR", "Ответ без пользователя")
                )
                sessionManager.saveAuthSuccess(user, token)
                RegistrationOutcome.SignedIn(user)
            }
            (answer["status"] as? JsonPrimitive)?.contentOrNull == "pending" -> RegistrationOutcome.Pending
            else -> throw ApiException(200, "SERIALIZATION_ERROR", "Ни сессии, ни заявки в ответе")
        }
    }

    /** Server side only: the caller wipes the local session once this returns. */
    suspend fun deleteAccount(password: String): Unit = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/users/me")
            .delete(json.encodeToString(DeleteAccountBody(password)).toRequestBody(jsonMediaType))
            .build()

        executeRequestNoContent(httpRequest)
    }

    suspend fun report(request: ReportBody): Unit = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/reports")
            .post(json.encodeToString(request).toRequestBody(jsonMediaType))
            .build()

        executeRequestNoContent(httpRequest)
    }

    suspend fun blockUser(userId: Long): Unit = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/blocks")
            .post(json.encodeToString(BlockBody(userId)).toRequestBody(jsonMediaType))
            .build()

        executeRequestNoContent(httpRequest)
    }

    suspend fun unblockUser(userId: Long): Unit = withContext(Dispatchers.IO) {
        executeRequestNoContent(Request.Builder().url("${getBaseUrl()}/blocks/$userId").delete().build())
    }

    /** `GET /api/blocks`: `{ blocks: [...] }`; a bare array is accepted too. */
    suspend fun blockedUsers(): List<BlockedUser> = withContext(Dispatchers.IO) {
        val answer: JsonElement = executeRequest(Request.Builder().url("${getBaseUrl()}/blocks").get().build())
        val entries = (answer as? JsonArray)
            ?: (answer as? JsonObject)?.let { it["blocks"] ?: it["users"] ?: it["blocked"] } as? JsonArray
            ?: JsonArray(emptyList())
        entries.mapNotNull { (it as? JsonObject)?.let(BlockedUser::from) }
    }

    suspend fun refreshToken(): RefreshResponse = withContext(Dispatchers.IO) {
        val refreshing = sessionManager.token
        try {
            val httpRequest = Request.Builder()
                .url("${getBaseUrl()}/auth/refresh")
                .post("{}".toRequestBody(jsonMediaType))
                .build()

            val response: RefreshResponse = executeRequest(httpRequest)
            sessionManager.token = response.token
            response
        } catch (error: ApiException) {
            if (RefreshFailurePolicy.shouldClearSession(error.statusCode) && refreshing != null) {
                sessionManager.clearSessionIfCurrent(refreshing)
            }
            throw error
        }
    }

    /**
     * Explicit sign-out. The session and the device secret are wiped here first (fail closed); then
     * `/auth/logout` names this device (push.md §2, final review I1), so the server revokes the token,
     * unbinds the device secret and drops this device's push tokens in one request.
     */
    suspend fun logout(): Unit = withContext(Dispatchers.IO) {
        val tokenForRemoteLogout = sessionManager.token
        val deviceId = runCatching { sessionManager.deviceId }.getOrNull()
        if (!sessionManager.clearSessionForSignOut()) {
            throw SecureStorageUnavailableException()
        }

        if (tokenForRemoteLogout.isNullOrBlank()) return@withContext

        val body = buildJsonObject { if (deviceId != null) put("device_id", JsonPrimitive(deviceId)) }
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/auth/logout")
            .header("Authorization", "Bearer $tokenForRemoteLogout")
            .post(body.toString().toRequestBody(jsonMediaType))
            .build()

        executeRequestNoContent(httpRequest)
    }

    /**
     * `POST /api/devices/push-token` (push.md §2): this device's FCM token for the signed-in account.
     * Only the token and ids go to the server; the answer says whether the server sends push at all.
     */
    suspend fun registerPushToken(token: String, deviceId: String?, appVersion: String): Unit = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("platform", JsonPrimitive("android"))
            put("token", JsonPrimitive(token))
            put("app_version", JsonPrimitive(appVersion))
            if (deviceId != null) put("device_id", JsonPrimitive(deviceId))
        }
        val httpRequest = Request.Builder()
            .url("${getBaseUrl()}/devices/push-token")
            .post(body.toString().toRequestBody(jsonMediaType))
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

    /** Справочник сотрудников (поля, открытые любому вошедшему). */
    suspend fun getUsers(): List<User> = withContext(Dispatchers.IO) {
        executeRequest(Request.Builder().url("${getBaseUrl()}/users").get().build())
    }

    /** Карточка сотрудника: себе — полная запись, коллеге — поля справочника. */
    suspend fun getUser(id: Long): User = withContext(Dispatchers.IO) {
        executeRequest(Request.Builder().url("${getBaseUrl()}/users/$id").get().build())
    }

    suspend fun getOrgTree(): OrgTree = withContext(Dispatchers.IO) {
        executeRequest(Request.Builder().url("${getBaseUrl()}/org/tree").get().build())
    }

    /** Поиск по сообщениям, доступным сотруднику: до 30 последних совпадений (сервер: 30 запросов в минуту). */
    suspend fun searchMessages(query: String): List<Message> = withContext(Dispatchers.IO) {
        val url = "${getBaseUrl()}/messages/search".toHttpUrlOrNull()?.newBuilder()
            ?.addQueryParameter("q", query)
            ?.build()
            ?: throw IllegalArgumentException("Invalid URL: ${getBaseUrl()}/messages/search")
        executeRequest(Request.Builder().url(url).get().build())
    }

    suspend fun getDirectMessages(targetId: Long, beforeId: Long? = null, limit: Int = 50, afterId: Long? = null): List<Message> =
        withContext(Dispatchers.IO) {
            val urlBuilder = "${getBaseUrl()}/messages/direct/$targetId".toHttpUrlOrNull()?.newBuilder()
                ?: throw IllegalArgumentException("Invalid URL: ${getBaseUrl()}/messages/direct/$targetId")

            if (beforeId != null) urlBuilder.addQueryParameter("beforeId", beforeId.toString())
            if (afterId != null) urlBuilder.addQueryParameter("afterId", afterId.toString())
            urlBuilder.addQueryParameter("limit", limit.toString())

            val httpRequest = Request.Builder()
                .url(urlBuilder.build())
                .get()
                .build()

            executeRequest(httpRequest)
        }

    suspend fun getChannelMessages(channelId: Long, beforeId: Long? = null, limit: Int = 50, afterId: Long? = null): List<Message> =
        withContext(Dispatchers.IO) {
            val urlBuilder = "${getBaseUrl()}/messages/channels/$channelId".toHttpUrlOrNull()?.newBuilder()
                ?: throw IllegalArgumentException("Invalid URL: ${getBaseUrl()}/messages/channels/$channelId")

            if (beforeId != null) urlBuilder.addQueryParameter("beforeId", beforeId.toString())
            if (afterId != null) urlBuilder.addQueryParameter("afterId", afterId.toString())
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

    /**
     * A request whose status the caller interprets (the delivery engine: `/sync` 410, `POST` 409/503).
     * Never throws for an HTTP status: no answer at all is status 0. The session rules still apply —
     * a 401 (after the token refresh failed) ends the session, as for every other request, but only
     * when it refused the session signed in now.
     *
     * Run in a [RequestOwner] context, the request is that account's: it goes only with its token,
     * and not at all (status 0) when another account, or nobody, is signed in (final review I4).
     */
    suspend fun raw(method: String, path: String, body: JsonElement? = null): RawResponse {
        val owner = currentCoroutineContext()[RequestOwner]?.userId
        return withContext(Dispatchers.IO) {
            // Contract paths carry the /api prefix; the base URL already ends with it.
            val relative = path.removePrefix("/api")
            val url = "${getBaseUrl()}$relative".toHttpUrlOrNull() ?: return@withContext RawResponse(0, "", null)
            val credentials = credentialsFor(owner) ?: return@withContext RawResponse(0, "", null)
            val request = Request.Builder().url(url).tag(BoundCredentials::class.java, credentials).apply {
                if (method == "GET") get() else method(method, (body ?: JsonObject(emptyMap())).toString().toRequestBody(jsonMediaType))
            }.build()
            val response = try {
                client.newCall(request).execute()
            } catch (e: IOException) {
                return@withContext RawResponse(0, "", null)
            }
            response.use {
                val text = it.body?.string().orEmpty()
                if (it.code == 401) endSessionRefused(refusedToken(it))
                if (it.code == 403 && text.contains("MUST_CHANGE_PASSWORD")) sessionManager.mustChangePassword = true
                RawResponse(it.code, text, retryAfterSeconds(it))
            }
        }
    }

    /**
     * The binding of a request made now: the current token, and [owner] when stated. Null — a
     * request for [owner] that must not go out, because the session is not that account's.
     */
    internal fun credentialsFor(owner: Long?): BoundCredentials? {
        val token = sessionManager.token
        if (owner != null && (token == null || JwtClaims.userId(token) != owner)) return null
        return BoundCredentials(token, owner)
    }

    /** The token a 401 refused: the one the request carried, else the one it was made with. */
    private fun refusedToken(response: Response): String? =
        response.request.header("Authorization")?.removePrefix("Bearer ")?.trim()?.takeIf { it.isNotEmpty() }
            ?: response.request.tag(BoundCredentials::class.java)?.token

    /** A 401 ends the session only when it refused the session signed in now (final review I4). */
    private fun endSessionRefused(token: String?) {
        if (token != null) sessionManager.clearSessionIfCurrent(token)
    }

    private inline fun <reified T> executeRequest(
        request: Request,
        requestClient: OkHttpClient = client
    ): T {
        val response = execute(requestClient, request)

        val bodyString = response.body?.string() ?: ""

        if (!response.isSuccessful) {
            handleErrorResponse(response.code, bodyString, retryAfterSeconds(response), refusedToken(response))
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
            handleErrorResponse(response.code, bodyString, retryAfterSeconds(response), refusedToken(response))
        }
    }

    /** Transport failures: a refused certificate is reported apart from being offline. */
    private fun execute(requestClient: OkHttpClient, request: Request): Response = try {
        // Bound to the session of the moment it is made, not of the moment OkHttp sends it.
        val bound = if (request.tag(BoundCredentials::class.java) != null) request
        else request.newBuilder().tag(BoundCredentials::class.java, BoundCredentials(sessionManager.token, null)).build()
        requestClient.newCall(bound).execute()
    } catch (e: SSLException) {
        throw ApiException(0, "TLS_ERROR", e.message ?: "Ошибка защищённого соединения")
    } catch (e: IOException) {
        throw ApiException(0, "NETWORK_ERROR", e.message ?: "Ошибка сети")
    }

    /** `Retry-After` in delta-seconds or as an HTTP-date ([RetryAfter]); anything else is ignored. */
    private fun retryAfterSeconds(response: Response): Long? =
        RetryAfter.seconds(response.header("Retry-After"), System.currentTimeMillis())

    /**
     * A refusal of a request made outside this class (attachments): the same session rules and
     * Russian text. [refusedToken] — the token the refused request carried.
     */
    internal fun raise(code: Int, bodyString: String, retryAfterSeconds: Long?, refusedToken: String?): Nothing =
        handleErrorResponse(code, bodyString, retryAfterSeconds, refusedToken)

    private fun handleErrorResponse(code: Int, bodyString: String, retryAfterSeconds: Long?, refusedToken: String?): Nothing {
        var errorCode: String? = null
        var errorMessage = "HTTP error $code"
        var attemptsLeft: Int? = null

        try {
            val jsonElement = json.parseToJsonElement(bodyString).jsonObject
            errorMessage = jsonElement["error"]?.jsonPrimitive?.content
                ?: jsonElement["message"]?.jsonPrimitive?.content
                ?: errorMessage
            errorCode = jsonElement["code"]?.jsonPrimitive?.content
            attemptsLeft = (jsonElement["attemptsLeft"] as? JsonPrimitive)?.intOrNull
        } catch (_: Exception) {}

        if (code == 403 && errorCode == "MUST_CHANGE_PASSWORD") {
            sessionManager.mustChangePassword = true
            throw MustChangePasswordException(errorMessage)
        }

        if (code == 401) {
            // A protected request reached the server and the session was rejected. Clear local
            // credentials so the navigation guard can return to sign-in — when it is this session's
            // refusal; a late refusal of an earlier account's token leaves the current one alone.
            endSessionRefused(refusedToken)
            throw UnauthorizedException(errorMessage)
        }

        throw ApiException(code, errorCode, errorMessage, retryAfterSeconds, attemptsLeft)
    }
}
