package com.openmychat.mobile.core.network

open class ApiException(
    val statusCode: Int,
    val errorCode: String? = null,
    message: String,
    /** Seconds from the `Retry-After` header (429/503), when the server sent one. */
    val retryAfterSeconds: Long? = null,
    /** `attemptsLeft` of a wrong registration code (`400 CODE_INVALID`), when the server sent it. */
    val attemptsLeft: Int? = null
) : Exception(message)

class MustChangePasswordException(
    message: String = "Требуется обязательная смена пароля"
) : ApiException(statusCode = 403, errorCode = "MUST_CHANGE_PASSWORD", message = message)

class UnauthorizedException(
    message: String = "Недействительный сессионный токен"
) : ApiException(statusCode = 401, errorCode = "UNAUTHORIZED", message = message)
