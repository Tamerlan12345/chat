package com.openmychat.mobile.data.realtime

import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.di.ApplicationScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/** Автоматическое присутствие: только эти два значения уходят на сервер (`SYSTEM_PRESENCE`). */
enum class Presence(val wire: String, val status: UserStatus) {
    ONLINE("online", UserStatus.ONLINE),
    AWAY("away", UserStatus.AWAY)
}

/**
 * Присутствие как на настольном клиенте (решение владельца): приложение на экране — «В сети»,
 * свёрнуто — «Отошёл». Вручную его не выбрать; «Не беспокоить» — отдельный переключатель
 * поверх присутствия (`set_dnd`), а «Не в сети» ставит только сервер, когда сокет закрылся.
 *
 * Отправляется только смена состояния; после каждого подключения (auth_success) текущее
 * состояние уходит снова, чтобы сервер не застрял на старом.
 */
@Singleton
class PresenceController @Inject constructor(
    private val realtime: RealtimeRepository,
    @ApplicationScope scope: CoroutineScope
) {
    private val _presence = MutableStateFlow(Presence.ONLINE)

    /** Жизненный цикл ещё ничего не сообщил: на сервер не отправляем догадку. */
    private var known = false

    /** Текущее автоматическое присутствие (профиль показывает «Сейчас: …»). */
    val presence: StateFlow<Presence> = _presence.asStateFlow()

    /** Что сервер уже знает от этого сокета; null — ничего (нет связи или новое подключение). */
    private var sent: Presence? = null

    init {
        scope.launch {
            realtime.connectionState.collect { state ->
                sent = null
                if (state is ConnectionState.Connected) push()
            }
        }
    }

    /** Процесс вышел на передний план (ProcessLifecycleOwner ON_START). */
    fun onForeground() = set(Presence.ONLINE)

    /** Все экраны приложения скрыты (ProcessLifecycleOwner ON_STOP). */
    fun onBackground() = set(Presence.AWAY)

    fun setDnd(enabled: Boolean): Boolean = realtime.setDnd(enabled)

    /** Свой статус («На встрече») уходит вместе с текущим присутствием, не меняя его. */
    fun publishCustomStatus(customStatus: String?): Boolean =
        realtime.sendCustomStatus(_presence.value.wire, customStatus)

    @Synchronized
    private fun set(value: Presence) {
        _presence.value = value
        known = true
        push()
    }

    @Synchronized
    private fun push() {
        val desired = _presence.value
        if (!known || sent == desired || realtime.connectionState.value !is ConnectionState.Connected) return
        if (realtime.sendPresence(desired.wire)) sent = desired
    }
}
