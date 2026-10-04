package com.openmychat.mobile.core.network

import com.openmychat.mobile.core.audio.SilenceGater
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min
import kotlin.random.Random

class WebSocketClient(
    private val sessionManager: SessionManager,
    private val okHttpClient: OkHttpClient? = null,
    private val webSocketFactory: ((Request, WebSocketListener) -> WebSocket)? = null,
    /** Что передать в auth кроме токена: в фоне ли приложение и какой чат открыт (multi-device.md §3). */
    private val authContext: AuthContext = AuthContext()
) {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
    }

    private val client: OkHttpClient by lazy {
        okHttpClient ?: OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(30, TimeUnit.SECONDS) // OkHttp automatically handles ping/pong
            .build()
    }

    private var webSocket: WebSocket? = null
    private var scope: CoroutineScope? = null
    private var reconnectJob: Job? = null

    private val isConnected = AtomicBoolean(false)
    private val isConnecting = AtomicBoolean(false)
    private val isManuallyClosed = AtomicBoolean(false)
    private var reconnectAttempts = 0

    private val _events = MutableSharedFlow<WsEvent>(extraBufferCapacity = 256)
    val events: SharedFlow<WsEvent> = _events.asSharedFlow()

    /**
     * Voice frames (~31/s during a call) have their own lossy flow, so they can never fill the chat
     * event buffer and make tryEmit drop messages, typing or call signalling.
     */
    private val _audioFrames = MutableSharedFlow<WsEvent.AudioFrameReceived>(
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )
    val audioFrames: SharedFlow<WsEvent.AudioFrameReceived> = _audioFrames.asSharedFlow()

    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    /** Token the server refused (auth_error); reconnecting with it again would only loop. */
    @Volatile private var rejectedToken: String? = null
    @Volatile private var authenticatingToken: String? = null

    /** The server sends new_message and direct_message/channel_message for the same message. */
    private val recentMessageIds = object : LinkedHashMap<Long, Unit>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, Unit>?): Boolean = size > 512
    }

    fun connect(coroutineScope: CoroutineScope) {
        scope = coroutineScope
        val token = sessionManager.token
        if (token != null && token == rejectedToken) return
        rejectedToken = null
        isManuallyClosed.set(false)
        if (isConnected.get() || !isConnecting.compareAndSet(false, true)) return
        establishConnection()
    }

    private fun establishConnection() {
        val token = sessionManager.token
        if (token.isNullOrBlank()) {
            isConnecting.set(false)
            _connectionState.value = ConnectionState.Disconnected
            return
        }

        val endpoint = sessionManager.serverEndpoint
        if (!endpoint.isSecure) {
            isConnecting.set(false)
            _connectionState.value = ConnectionState.Disconnected
            return
        }
        authenticatingToken = token
        // During a refusal streak keep showing the reason instead of flickering to "connecting".
        if (_connectionState.value !is ConnectionState.Retrying) {
            _connectionState.value = ConnectionState.Connecting
        }

        // Аватары ссылкой и в событиях WebSocket (sender_avatar, профиль в auth_success).
        val wsUrl = AvatarOptIn.webSocketUrl(endpoint.webSocketUrl)
        val request = Request.Builder()
            .url(wsUrl)
            .header("User-Agent", "CentyChat-Android/1.0.0")
            .build()

        val listener = object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                if (ws !== webSocket) return
                isConnected.set(true)
                isConnecting.set(false)
                // reconnectAttempts is reset only on auth_success: the server refuses sessions
                // (TOO_MANY_SESSIONS, RATE_LIMITED) on sockets that did open.
                // Authenticate immediately upon connection
                sendAuth(token)
            }

            override fun onMessage(ws: WebSocket, text: String) {
                if (ws === webSocket) handleTextMessage(text)
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                if (ws === webSocket) handleBinaryMessage(bytes)
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                if (ws !== webSocket) return
                isConnected.set(false)
                isConnecting.set(false)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                // Callbacks of a socket we already replaced or closed ourselves are ignored.
                if (ws !== webSocket) return
                onSocketLost()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                if (ws !== webSocket) return
                onSocketLost()
            }
        }
        webSocket = webSocketFactory?.invoke(request, listener) ?: client.newWebSocket(request, listener)
    }

    private fun onSocketLost() {
        webSocket = null
        isConnected.set(false)
        isConnecting.set(false)
        if (!isManuallyClosed.get()) {
            _connectionState.value = ConnectionState.Connecting
            scheduleReconnect()
        } else if (_connectionState.value !is ConnectionState.Unauthorized) {
            _connectionState.value = ConnectionState.Disconnected
        }
    }

    /** Closes the current socket without triggering the listener-driven reconnect. */
    private fun closeCurrentSocket(reason: String) {
        val ws = webSocket
        webSocket = null
        isConnected.set(false)
        isConnecting.set(false)
        ws?.close(1000, reason)
    }

    private fun handleAuthError(code: String, message: String) {
        when (code) {
            // The token itself is not acceptable: stop until the session changes (new login, refresh,
            // password change). The app verifies the session over HTTP and signs out on 401.
            "INVALID_TOKEN", "MUST_CHANGE_PASSWORD" -> {
                rejectedToken = authenticatingToken
                isManuallyClosed.set(true)
                reconnectJob?.cancel()
                closeCurrentSocket("Authentication rejected")
                _connectionState.value = ConnectionState.Unauthorized(code, message)
                _events.tryEmit(WsEvent.AuthError(code, message))
            }
            // Too many sessions / rate limited / unknown: transient, retry with growing delays.
            else -> {
                closeCurrentSocket("Authentication deferred")
                val alreadyReported = (_connectionState.value as? ConnectionState.Retrying)?.code == code
                _connectionState.value = ConnectionState.Retrying(code, message)
                if (!alreadyReported) _events.tryEmit(WsEvent.AuthError(code, message))
                scheduleReconnect(
                    minDelayMs = if (code == "TOO_MANY_SESSIONS") SESSION_LIMIT_MIN_DELAY_MS else REFUSAL_MIN_DELAY_MS,
                    maxDelayMs = REFUSAL_MAX_DELAY_MS
                )
            }
        }
    }

    private fun scheduleReconnect(minDelayMs: Long = 1_000L, maxDelayMs: Long = 30_000L) {
        if (isManuallyClosed.get()) return
        val currentScope = scope ?: return

        reconnectJob?.cancel()
        reconnectJob = currentScope.launch {
            reconnectAttempts++
            // Exponential backoff from minDelayMs (x2 per attempt) up to maxDelayMs, +-20% jitter.
            val baseDelay = min(maxDelayMs, minDelayMs * (1L shl (reconnectAttempts.coerceAtMost(6) - 1)))
            val jitter = (baseDelay * 0.2f * (Random.nextFloat() * 2f - 1f)).toLong()
            val totalDelay = (baseDelay + jitter).coerceAtLeast(500L)

            delay(totalDelay)
            if (!isManuallyClosed.get() && !isConnected.get() && isConnecting.compareAndSet(false, true)) {
                establishConnection()
            }
        }
    }

    private fun sendAuth(token: String) {
        sendJson(authFrame(token, runCatching { sessionManager.deviceId }.getOrNull(), authContext.snapshot()).toString())
    }

    private fun handleTextMessage(text: String) {
        try {
            val event = (WsEventParser.parse(text) as? WsFrame.Event)?.event ?: return
            when (event) {
                is WsEvent.AuthSuccess -> {
                    sessionManager.currentUser = event.user
                    reconnectAttempts = 0
                    _connectionState.value = ConnectionState.Connected
                    _events.tryEmit(event)
                }
                is WsEvent.AuthError -> {
                    if (event.code == "MUST_CHANGE_PASSWORD") {
                        sessionManager.mustChangePassword = true
                    }
                    handleAuthError(event.code, event.message)
                }
                is WsEvent.NewMessage -> {
                    val firstDelivery = synchronized(recentMessageIds) {
                        recentMessageIds.put(event.message.id, Unit) == null
                    }
                    if (firstDelivery) _events.tryEmit(event)
                }
                else -> _events.tryEmit(event)
            }
        } catch (_: Exception) {}
    }

    private fun handleBinaryMessage(bytes: ByteString) {
        // Audio frame must be exactly 1028 bytes: 4 bytes senderId + 1024 bytes PCM (512 Int16)
        if (bytes.size != 1028) return

        val buffer = ByteBuffer.wrap(bytes.toByteArray()).order(ByteOrder.BIG_ENDIAN)
        val senderId = buffer.int.toLong() and 0xFFFFFFFFL

        val samples = ShortArray(512)
        for (i in 0 until 512) {
            samples[i] = buffer.short
        }

        _audioFrames.tryEmit(WsEvent.AudioFrameReceived(senderId, samples))
    }

    private fun sendJson(jsonString: String): Boolean {
        return webSocket?.send(jsonString) ?: false
    }

    fun sendTextMessage(
        conversationType: ConversationType,
        targetId: Long,
        text: String,
        replyToId: Long? = null,
        metadata: MessageMetadata? = null,
        /** Ключ идемпотентности: повтор с тем же ключом не создаёт копию (ws-protocol §3.2). */
        clientMsgId: String? = null
    ): Boolean {
        val payload = buildJsonObject {
            put("type", "send_message")
            put("conversationType", conversationType.value)
            put("targetId", targetId)
            put("text", text)
            put("msgType", "text")
            if (replyToId != null) put("replyToId", replyToId)
            if (metadata != null) {
                put("metadata", json.encodeToJsonElement(metadata))
            }
            if (clientMsgId != null) put("client_msg_id", clientMsgId)
        }
        return sendJson(payload.toString())
    }

    /** Отзыв отправки по ключу: сервер не сохранит её позже и удалит, если уже сохранил (ws-protocol §3.4.1). */
    fun cancelMessage(clientMsgId: String): Boolean {
        val payload = buildJsonObject {
            put("type", "cancel_message")
            put("client_msg_id", clientMsgId)
        }
        return sendJson(payload.toString())
    }

    fun editMessage(messageId: Long, text: String): Boolean {
        val payload = buildJsonObject {
            put("type", "edit_message")
            put("messageId", messageId)
            put("text", text)
        }
        return sendJson(payload.toString())
    }

    fun deleteMessage(messageId: Long): Boolean {
        val payload = buildJsonObject {
            put("type", "delete_message")
            put("messageId", messageId)
        }
        return sendJson(payload.toString())
    }

    /** «Смотрю этот чат» (null — ни один): сервер не уведомляет о нём ни одно устройство сотрудника. */
    fun sendViewing(conversationType: ConversationType?, targetId: Long?): Boolean =
        sendJson(viewingFrame(conversationType, targetId).toString())

    fun markRead(conversationType: ConversationType, targetId: Long): Boolean {
        val payload = buildJsonObject {
            put("type", "mark_read")
            put("conversationType", conversationType.value)
            put("targetId", targetId)
        }
        return sendJson(payload.toString())
    }

    fun sendTyping(conversationType: ConversationType, targetId: Long, isTyping: Boolean): Boolean {
        val payload = buildJsonObject {
            put("type", "typing")
            put("conversationType", conversationType.value)
            put("targetId", targetId)
            put("isTyping", isTyping)
        }
        return sendJson(payload.toString())
    }

    /**
     * Сигнал системы о присутствии: «online» или «away». Без [includeCustomStatus] поле
     * customStatus не отправляется вовсе — сервер считает null командой стереть свой статус.
     */
    fun sendPresence(state: String, customStatus: String? = null, includeCustomStatus: Boolean = false): Boolean {
        val payload = buildJsonObject {
            put("type", "presence")
            put("state", state)
            if (includeCustomStatus) {
                if (customStatus != null) put("customStatus", customStatus) else put("customStatus", JsonNull)
            }
        }
        return sendJson(payload.toString())
    }

    /** «Не беспокоить» поверх присутствия; свой статус не трогает. */
    fun setDnd(enabled: Boolean): Boolean {
        val payload = buildJsonObject {
            put("type", "set_dnd")
            put("enabled", enabled)
        }
        return sendJson(payload.toString())
    }

    fun sendWake(targetUserId: Long): Boolean {
        val payload = buildJsonObject {
            put("type", "wake_send")
            put("targetUserId", targetUserId)
        }
        return sendJson(payload.toString())
    }

    fun sendCallOffer(targetUserId: Long): Boolean {
        val payload = buildJsonObject {
            put("type", "call_offer")
            put("targetUserId", targetUserId)
        }
        return sendJson(payload.toString())
    }

    fun sendCallAnswer(targetUserId: Long): Boolean {
        val payload = buildJsonObject {
            put("type", "call_answer")
            put("targetUserId", targetUserId)
        }
        return sendJson(payload.toString())
    }

    fun sendCallRejected(targetUserId: Long, reason: String? = null): Boolean {
        val payload = buildJsonObject {
            put("type", "call_rejected")
            put("targetUserId", targetUserId)
            if (reason != null) put("reason", reason)
        }
        return sendJson(payload.toString())
    }

    fun sendCallEnd(targetUserId: Long, reason: String? = null): Boolean {
        val payload = buildJsonObject {
            put("type", "call_end")
            put("targetUserId", targetUserId)
            if (reason != null) put("reason", reason)
        }
        return sendJson(payload.toString())
    }

    fun sendAudioFrame(targetUserId: Long, pcmSamples: ShortArray): Boolean {
        if (pcmSamples.size != 512) return false
        if (SilenceGater.isSilence(pcmSamples)) return false

        val buffer = ByteBuffer.allocate(1028).order(ByteOrder.BIG_ENDIAN)
        buffer.putInt((targetUserId and 0xFFFFFFFFL).toInt())
        for (sample in pcmSamples) {
            buffer.putShort(sample)
        }

        val byteString = buffer.array().toByteString()
        return webSocket?.send(byteString) ?: false
    }

    fun disconnect() {
        isManuallyClosed.set(true)
        reconnectJob?.cancel()
        reconnectJob = null
        closeCurrentSocket("Normal closure")
        _connectionState.value = ConnectionState.Disconnected
    }

    companion object {
        private val DEVICE_ID = Regex("^[A-Za-z0-9._:-]{1,128}$")

        /**
         * Кадр auth (multi-device.md §3): device_id — тот же, что в knock и регистрации push, чтобы
         * сервер связал сокет с устройством; в фоне — presence "away"; открытый чат — viewing.
         */
        fun authFrame(token: String, deviceId: String?, state: AuthContext.Snapshot): JsonObject = buildJsonObject {
            put("type", "auth")
            put("token", token)
            if (deviceId != null && DEVICE_ID.matches(deviceId)) put("device_id", deviceId)
            put("platform", "android")
            if (state.background) {
                put("presence", "away")
            } else if (state.viewing != null) {
                put("viewing", buildJsonObject {
                    put("conversationType", state.viewing.first.value)
                    put("targetId", state.viewing.second)
                })
            }
        }

        fun viewingFrame(conversationType: ConversationType?, targetId: Long?): JsonObject = buildJsonObject {
            put("type", "viewing")
            if (conversationType == null || targetId == null) {
                put("conversationType", JsonNull)
            } else {
                put("conversationType", conversationType.value)
                put("targetId", targetId)
            }
        }

        private const val SESSION_LIMIT_MIN_DELAY_MS = 10_000L
        private const val REFUSAL_MIN_DELAY_MS = 2_000L
        private const val REFUSAL_MAX_DELAY_MS = 60_000L
    }
}
