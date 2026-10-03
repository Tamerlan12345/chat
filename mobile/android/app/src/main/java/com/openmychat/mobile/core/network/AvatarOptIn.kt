package com.openmychat.mobile.core.network

import okhttp3.HttpUrl

/**
 * Аватары ссылкой вместо data URL (сервер, задача 20; `mobile/contracts`): HTTP-запросы к своему
 * серверу несут `X-Avatar-Format: url`, WebSocket подключается с `?avatars=url`. Тогда в
 * `avatar_url` и `sender_avatar` приходит `/api/users/<id>/avatar?v=<версия>`, а картинка
 * берётся нужного размера (`size=s` — 96 px, `size=m` — 256 px) и кэшируется.
 */
object AvatarOptIn {
    const val HEADER = "X-Avatar-Format"
    const val VALUE = "url"

    enum class Size(val query: String) { SMALL("s"), MEDIUM("m") }

    /** Маленькая картинка (96 px) для аватаров до 48 dp, средняя (256 px) — для карточки. */
    fun sizeFor(diameterDp: Float): Size = if (diameterDp <= 48f) Size.SMALL else Size.MEDIUM

    fun webSocketUrl(base: String): String = if (base.contains('?')) "$base&avatars=$VALUE" else "$base?avatars=$VALUE"

    /** Добавляет размер только к аватарам своего сервера (`/api/users/<id>/avatar`). */
    fun sized(url: HttpUrl, size: Size): HttpUrl =
        if (AVATAR_PATH.matches(url.encodedPath)) url.newBuilder().setQueryParameter("size", size.query).build() else url

    private val AVATAR_PATH = Regex("^/api/users/\\d+/avatar$")
}
