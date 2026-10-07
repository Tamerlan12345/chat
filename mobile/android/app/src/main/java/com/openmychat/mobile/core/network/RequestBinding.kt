package com.openmychat.mobile.core.network

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import java.io.IOException
import java.util.Base64
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

/**
 * The account an HTTP request is made for (final review I4). The delivery engine and the uploads run
 * their requests in this context; [ApiClient] binds such a request to that account's token, or does
 * not send it at all when another account (or nobody) is signed in by then.
 */
class RequestOwner(val userId: Long) : AbstractCoroutineContextElement(Key) {
    companion object Key : CoroutineContext.Key<RequestOwner>
}

/**
 * OkHttp tag: the session token a request was made with ([token] null — made signed out) and, when
 * stated, the account it is for. The token is read when the request is made, not when OkHttp
 * dispatches it, so a request never picks up a session that began after it.
 */
class BoundCredentials(val token: String?, val owner: Long?)

/** The account a request was made for is no longer signed in: the request is not sent. */
class AccountChangedException : IOException("Учётная запись сменилась — запрос не отправлен")

/** Claims of the server's session token (a JWT whose payload carries `userId`). */
object JwtClaims {
    private val json = Json { ignoreUnknownKeys = true }

    /** The account a token was issued to; null when [token] is not a readable JWT. */
    fun userId(token: String?): Long? {
        val parts = token?.split('.') ?: return null
        if (parts.size < 2) return null
        return runCatching {
            val payload = String(Base64.getUrlDecoder().decode(parts[1].trimEnd('=')), Charsets.UTF_8)
            (json.parseToJsonElement(payload).jsonObject["userId"] as? JsonPrimitive)?.let {
                it.longOrNull ?: it.content.toLongOrNull()
            }
        }.getOrNull()?.takeIf { it > 0 }
    }

    /** Both tokens name the same account. Tokens of unknown account are never the same (fail closed). */
    fun sameAccount(a: String?, b: String?): Boolean {
        val first = userId(a) ?: return false
        return first == userId(b)
    }
}
