package com.openmychat.mobile.data.delivery

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/** Side effects of one reducer step (delivery-state.md §5), executed strictly in order. */
sealed interface DeliveryEffect {
    fun toJson(): JsonObject

    /** Barrier: durably write these slices of the new state before anything else runs. */
    data class Persist(val slices: List<String>) : DeliveryEffect {
        override fun toJson() = buildJsonObject {
            put("type", "persist")
            putJsonArray("slices") { slices.forEach { add(JsonPrimitive(it)) } }
        }
    }

    data class ClearComposer(val conversation: String) : DeliveryEffect {
        override fun toJson() = buildJsonObject {
            put("type", "clear_composer")
            put("conversation", conversation)
        }
    }

    data class SendWs(val frame: JsonObject) : DeliveryEffect {
        override fun toJson() = buildJsonObject {
            put("type", "send_ws")
            put("frame", frame)
        }
    }

    data class SendHttp(
        val clientMsgId: String,
        val attempt: Long,
        val method: String,
        val path: String,
        val body: JsonObject
    ) : DeliveryEffect {
        override fun toJson() = buildJsonObject {
            put("type", "send_http")
            put("client_msg_id", clientMsgId)
            put("attempt", attempt)
            put("method", method)
            put("path", path)
            put("body", body)
        }
    }

    /** Dispatch [event] (plus `now`) at or after [at]. */
    data class Schedule(val at: Long, val event: JsonObject) : DeliveryEffect {
        override fun toJson() = buildJsonObject {
            put("type", "schedule")
            put("at", at)
            put("event", event)
        }
    }

    data class SyncRequest(val cursor: String?, val limit: Int, val chain: Long) : DeliveryEffect {
        override fun toJson() = buildJsonObject {
            put("type", "sync_request")
            put("cursor", cursor?.let(::JsonPrimitive) ?: JsonNull)
            put("limit", limit)
            put("chain", chain)
        }
    }

    data object RefreshConversationLists : DeliveryEffect {
        override fun toJson() = buildJsonObject { put("type", "refresh_conversation_lists") }
    }

    data class LoadHistory(val conversation: String) : DeliveryEffect {
        override fun toJson() = buildJsonObject {
            put("type", "load_history")
            put("conversation", conversation)
        }
    }

    data class UserError(val code: String) : DeliveryEffect {
        override fun toJson() = buildJsonObject {
            put("type", "user_error")
            put("code", code)
        }
    }
}
