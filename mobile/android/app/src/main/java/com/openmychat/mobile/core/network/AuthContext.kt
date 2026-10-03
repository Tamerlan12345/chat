package com.openmychat.mobile.core.network

import com.openmychat.mobile.data.model.ConversationType
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Состояние устройства для кадра auth (multi-device.md §3): в фоне ли приложение и какой чат открыт
 * на переднем плане. Пишет [com.openmychat.mobile.data.realtime.PresenceController], читает
 * [WebSocketClient] при каждом входе — так переподключение в фоне сразу входит «отошёл», а с открытым
 * чатом — сразу «смотрит» его, без окна до первого кадра presence / viewing.
 */
@Singleton
class AuthContext @Inject constructor() {
    data class Snapshot(val background: Boolean, val viewing: Pair<ConversationType, Long>?)

    @Volatile private var current = Snapshot(background = false, viewing = null)

    fun snapshot(): Snapshot = current

    fun update(background: Boolean, viewing: Pair<ConversationType, Long>?) {
        current = Snapshot(background, if (background) null else viewing)
    }
}
