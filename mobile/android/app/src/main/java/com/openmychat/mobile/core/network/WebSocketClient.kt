package com.openmychat.mobile.core.network

import com.openmychat.mobile.core.audio.SilenceGater
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
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
    private val okHttpClient: OkHttpClient? = null
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
    private val isManuallyClosed = AtomicBoolean(false)
    private var reconnectAttempts = 0

    private val _events = MutableSharedFlow<WsEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<WsEvent> = _events.asSharedFlow()

    fun connect(coroutineScope: CoroutineScope) {
        scope = coroutineScope
        isManuallyClosed.set(false)
        establishConnection()
    }

    private fun establishConnection() {
        val token = sessionManager.token
        if (token.isNullOrBlank()) {
            return
        }

        val endpoint = sessionManager.validateServerEndpoint(sessionManager.serverUrl).getOrNull() ?: return
        if (!endpoint.isSecure) return

        val wsUrl = endpoint.webSocketUrl
        val request = Request.Builder()
            .url(wsUrl)
            .header("User-Agent", "CentyChat-Android/1.0.0")
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                isConnected.set(true)
                reconnectAttempts = 0
                // Authenticate immediately upon connection
                sendAuth(token)
            }

            override fun onMessage(ws: WebSocket, text: String) {
                handleTextMessage(text)
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                handleBinaryMessage(bytes)
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                isConnected.set(false)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                isConnected.set(false)
                if (!isManuallyClosed.get()) {
                    scheduleReconnect()
                }
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                isConnected.set(false)
                if (!isManuallyClosed.get()) {
                    scheduleReconnect()
                }
            }
        })
    }

    private fun scheduleReconnect() {
        if (isManuallyClosed.get()) return
        val currentScope = scope ?: return

        reconnectJob?.cancel()
        reconnectJob = currentScope.launch(Dispatchers.IO) {
            reconnectAttempts++
            // Exponential backoff: 1s, 2s, 4s... max 30s with +-20% jitter
            val baseDelay = min(30000L, (1000L * (1L shl (reconnectAttempts.coerceAtMost(5) - 1))))
            val jitter = (baseDelay * 0.2f * (Random.nextFloat() * 2f - 1f)).toLong()
            val totalDelay = (baseDelay + jitter).coerceAtLeast(500L)

            delay(totalDelay)
            if (!isManuallyClosed.get() && !isConnected.get()) {
                establishConnection()
            }
        }
    }

    private fun sendAuth(token: String) {
        val authPayload = buildJsonObject {
            put("type", "auth")
            put("token", token)
        }
        sendJson(authPayload.toString())
    }

    private fun handleTextMessage(text: String) {
        try {
            val root = json.parseToJsonElement(text).jsonObject
            val type = root["type"]?.jsonPrimitive?.content ?: return

            when (type) {
                "auth_success" -> {
                    val userObj = root["user"]
                    if (userObj != null) {
                        val user = json.decodeFromJsonElement<User>(userObj)
                        sessionManager.currentUser = user
                        _events.tryEmit(WsEvent.AuthSuccess(user))
                    }
                }
                "auth_error" -> {
                    val code = root["code"]?.jsonPrimitive?.content ?: "UNKNOWN"
                    val message = root["message"]?.jsonPrimitive?.content ?: "Auth error"
                    if (code == "MUST_CHANGE_PASSWORD") {
                        sessionManager.mustChangePassword = true
                    }
                    _events.tryEmit(WsEvent.AuthError(code, message))
                }
                "wake_state" -> {
                    val targetUserId = root["targetUserId"]?.jsonPrimitive?.longOrNull
                    val retryAt = root["retryAt"]?.jsonPrimitive?.longOrNull ?: 0L
                    _events.tryEmit(WsEvent.WakeState(targetUserId, retryAt))
                }
                "server_disconnect" -> {
                    val reason = root["reason"]?.jsonPrimitive?.content ?: "Disconnected by server"
                    _events.tryEmit(WsEvent.ServerDisconnect(reason))
                }
                "new_message", "direct_message", "channel_message" -> {
                    val messageObj = root["message"]
                    if (messageObj != null) {
                        val message = json.decodeFromJsonElement<Message>(messageObj)
                        _events.tryEmit(WsEvent.NewMessage(message))
                    }
                }
                "message_status_updated" -> {
                    val messageId = root["messageId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val status = root["status"]?.jsonPrimitive?.content ?: "delivered"
                    val userId = root["userId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val timestamp = root["timestamp"]?.jsonPrimitive?.content ?: ""
                    _events.tryEmit(WsEvent.MessageStatusUpdated(messageId, status, userId, timestamp))
                }
                "messages_read" -> {
                    val byUserId = root["byUserId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val messageIds = root["messageIds"]?.jsonArray?.mapNotNull { it.jsonPrimitive.longOrNull } ?: emptyList()
                    _events.tryEmit(WsEvent.MessagesRead(byUserId, messageIds))
                }
                "message_updated" -> {
                    val messageObj = root["message"]?.jsonObject
                    if (messageObj != null) {
                        val id = messageObj["id"]?.jsonPrimitive?.longOrNull ?: 0L
                        val newText = messageObj["text"]?.jsonPrimitive?.content ?: ""
                        val updatedAt = messageObj["updated_at"]?.jsonPrimitive?.content ?: ""
                        _events.tryEmit(WsEvent.MessageUpdated(id, newText, updatedAt))
                    }
                }
                "message_deleted" -> {
                    val messageId = root["messageId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val conversationType = root["conversationType"]?.jsonPrimitive?.content ?: "direct"
                    val targetId = root["targetId"]?.jsonPrimitive?.longOrNull ?: 0L
                    _events.tryEmit(WsEvent.MessageDeleted(messageId, conversationType, targetId))
                }
                "user_typing" -> {
                    val userId = root["userId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val userName = root["userName"]?.jsonPrimitive?.content ?: ""
                    val conversationType = root["conversationType"]?.jsonPrimitive?.content ?: "direct"
                    val targetId = root["targetId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val isTyping = root["isTyping"]?.jsonPrimitive?.booleanOrNull ?: false
                    _events.tryEmit(WsEvent.UserTyping(userId, userName, conversationType, targetId, isTyping))
                }
                "user_status_changed" -> {
                    val userId = root["userId"]?.jsonPrimitive?.longOrNull
                        ?: root["user_id"]?.jsonPrimitive?.longOrNull ?: 0L
                    val statusStr = root["status"]?.jsonPrimitive?.content
                    val customStatus = root["customStatus"]?.jsonPrimitive?.content
                    _events.tryEmit(WsEvent.UserStatusChanged(userId, UserStatus.fromValue(statusStr), customStatus))
                }
                "channel_created" -> {
                    val channelObj = root["channel"]
                    if (channelObj != null) {
                        val channel = json.decodeFromJsonElement<Channel>(channelObj)
                        _events.tryEmit(WsEvent.ChannelCreated(channel))
                    }
                }
                "channel_deleted" -> {
                    val channelId = root["channelId"]?.jsonPrimitive?.longOrNull ?: 0L
                    _events.tryEmit(WsEvent.ChannelDeleted(channelId))
                }
                "new_announcement" -> {
                    val annObj = root["announcement"]
                    if (annObj != null) {
                        val announcement = json.decodeFromJsonElement<Announcement>(annObj)
                        _events.tryEmit(WsEvent.NewAnnouncement(announcement))
                    }
                }
                "announcement_acknowledged" -> {
                    val annId = root["announcementId"]?.jsonPrimitive?.content ?: ""
                    val userId = root["userId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val userName = root["userName"]?.jsonPrimitive?.content ?: ""
                    _events.tryEmit(WsEvent.AnnouncementAcknowledged(annId, userId, userName))
                }
                "call_offer" -> {
                    val target = root["targetUserId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val sender = root["senderId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val senderName = root["senderName"]?.jsonPrimitive?.content ?: "Коллега"
                    _events.tryEmit(WsEvent.CallOffer(target, sender, senderName))
                }
                "call_answer" -> {
                    val target = root["targetUserId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val sender = root["senderId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val senderName = root["senderName"]?.jsonPrimitive?.content ?: "Коллега"
                    _events.tryEmit(WsEvent.CallAnswer(target, sender, senderName))
                }
                "call_rejected" -> {
                    val target = root["targetUserId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val sender = root["senderId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val senderName = root["senderName"]?.jsonPrimitive?.content ?: ""
                    val reason = root["reason"]?.jsonPrimitive?.content
                    _events.tryEmit(WsEvent.CallRejected(target, sender, senderName, reason))
                }
                "call_end" -> {
                    val target = root["targetUserId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val sender = root["senderId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val senderName = root["senderName"]?.jsonPrimitive?.content ?: ""
                    val reason = root["reason"]?.jsonPrimitive?.content
                    _events.tryEmit(WsEvent.CallEnd(target, sender, senderName, reason))
                }
                "call_denied" -> {
                    val reason = root["reason"]?.jsonPrimitive?.content ?: "Звонок запрещен"
                    _events.tryEmit(WsEvent.CallDenied(reason))
                }
                "call_unavailable" -> {
                    val target = root["targetUserId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val reason = root["reason"]?.jsonPrimitive?.content ?: "Абонент недоступен"
                    _events.tryEmit(WsEvent.CallUnavailable(target, reason))
                }
                "wake_ring" -> {
                    val fromUserId = root["fromUserId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val fromName = root["fromName"]?.jsonPrimitive?.content ?: "Коллега"
                    val at = root["at"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis()
                    _events.tryEmit(WsEvent.WakeRing(fromUserId, fromName, at))
                }
                "wake_sent" -> {
                    val targetUserId = root["targetUserId"]?.jsonPrimitive?.longOrNull ?: 0L
                    val at = root["at"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis()
                    val retryAt = root["retryAt"]?.jsonPrimitive?.longOrNull ?: (at + 60000L)
                    _events.tryEmit(WsEvent.WakeSent(targetUserId, at, retryAt))
                }
                "wake_error" -> {
                    val code = root["code"]?.jsonPrimitive?.content ?: "error"
                    val message = root["message"]?.jsonPrimitive?.content ?: "Не удалось отправить побудку"
                    _events.tryEmit(WsEvent.WakeError(code, message))
                }
                "error" -> {
                    val context = root["context"]?.jsonPrimitive?.content
                    val message = root["message"]?.jsonPrimitive?.content ?: "Server error"
                    val origText = root["text"]?.jsonPrimitive?.content
                    _events.tryEmit(WsEvent.GenericError(context, message, origText))
                }
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

        _events.tryEmit(WsEvent.AudioFrameReceived(senderId, samples))
    }

    private fun sendJson(jsonString: String): Boolean {
        return webSocket?.send(jsonString) ?: false
    }

    fun sendTextMessage(
        conversationType: ConversationType,
        targetId: Long,
        text: String,
        replyToId: Long? = null,
        metadata: MessageMetadata? = null
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

    fun sendPresence(state: String, customStatus: String?): Boolean {
        val payload = buildJsonObject {
            put("type", "presence")
            put("state", state)
            if (customStatus != null) put("customStatus", customStatus) else put("customStatus", JsonNull)
        }
        return sendJson(payload.toString())
    }

    fun setDnd(enabled: Boolean, customStatus: String? = null): Boolean {
        val payload = buildJsonObject {
            put("type", "set_dnd")
            put("enabled", enabled)
            if (customStatus != null) put("customStatus", customStatus) else put("customStatus", JsonNull)
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
        webSocket?.close(1000, "Normal closure")
        webSocket = null
        isConnected.set(false)
    }
}
