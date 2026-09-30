package com.openmychat.mobile.core.network

open class ApiException(
    val statusCode: Int,
    val errorCode: String? = null,
    message: String
) : Exception(message)

class MustChangePasswordException(
    message: String = "Требуется обязательная смена пароля"
) : ApiException(statusCode = 403, errorCode = "MUST_CHANGE_PASSWORD", message = message)

class UnauthorizedException(
    message: String = "Недействительный сессионный токен"
) : ApiException(statusCode = 401, errorCode = "UNAUTHORIZED", message = message)
