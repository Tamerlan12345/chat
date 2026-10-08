package com.openmychat.mobile.data.realtime

import com.openmychat.mobile.core.network.AuthContext
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.di.ApplicationScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
 * Вместе с присутствием — сигнал «смотрю этот чат» (`viewing`, multi-device.md §4): чат открыт на
 * переднем плане — сервер не уведомляет о нём ни одно устройство сотрудника. Порядок: сначала
 * присутствие, потом viewing (сервер учитывает viewing только у сокета «в сети»); в фоне viewing
 * не шлётся — сервер снимает его сам по `presence: away`.
 *
 * Отправляется только смена состояния; после каждого подключения и возврата «в сети» текущее
 * состояние уходит снова — по самому событию auth_success, а не по StateFlow состояния связи:
 * быстрое «подключено → переподключение → подключено» StateFlow склеил бы, и повтор потерялся бы.
 * Кадры viewing — не чаще [VIEWING_MIN_GAP_MS] (предел сервера — 20 в секунду): частые смены
 * склеиваются, уходит последнее состояние.
 */
@Singleton
class PresenceController @Inject constructor(
    private val realtime: RealtimeRepository,
    @ApplicationScope private val scope: CoroutineScope,
    private val activeConversations: ActiveConversationRegistry = ActiveConversationRegistry(),
    private val authContext: AuthContext = AuthContext()
) {
    private val _presence = MutableStateFlow(Presence.ONLINE)

    /** Жизненный цикл ещё ничего не сообщил: на сервер не отправляем догадку. */
    private var known = false

    /** Текущее автоматическое присутствие (профиль показывает «Сейчас: …»). */
    val presence: StateFlow<Presence> = _presence.asStateFlow()

    /** Что сервер уже знает от этого сокета; null — ничего (нет связи или новое подключение). */
    private var sent: Presence? = null

    /** Последний отправленный viewing; [UNSENT] — сервер не знает (новый вход, возврат «в сети»). */
    private var sentViewing: Any? = UNSENT
    private var viewingCooldown: Job? = null

    init {
        scope.launch {
            realtime.events.collect { event -> if (event is WsEvent.AuthSuccess) onAuthenticated() }
        }
        scope.launch {
            // Связь пропала — сервер этого сокета больше не знает: отправим заново после входа.
            realtime.connectionState.collect { state -> if (state !is ConnectionState.Connected) forget() }
        }
        scope.launch {
            activeConversations.active.collect { push() }
        }
    }

    @Synchronized
    private fun forget() {
        sent = null
        sentViewing = UNSENT
    }

    @Synchronized
    private fun onAuthenticated() {
        sent = null
        sentViewing = UNSENT
        push()
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

    /** Открытый на переднем плане чат — то, что сервер должен считать «смотрит». */
    private fun desiredViewing(): Pair<ConversationType, Long>? {
        if (!known || _presence.value != Presence.ONLINE) return null
        return activeConversations.active.value?.let { it.type to it.targetId }
    }

    @Synchronized
    private fun push() {
        val desired = _presence.value
        val viewing = desiredViewing()
        authContext.update(background = known && desired == Presence.AWAY, viewing = viewing)
        if (!known || realtime.connectionState.value !is ConnectionState.Connected) return
        if (sent != desired) {
            if (!realtime.sendPresence(desired.wire)) return
            sent = desired
            // Смена присутствия обнуляет viewing на сервере («отошёл» снимает его сам, у нового
            // сокета его нет): «ничего не смотрю» повторно слать не нужно, открытый чат — заново.
            sentViewing = null
        }
        if (desired != Presence.ONLINE || viewing == sentViewing) return
        if (viewingCooldown?.isActive == true) return // уйдёт по окончании паузы
        if (!realtime.sendViewing(viewing)) return
        sentViewing = viewing
        viewingCooldown = scope.launch {
            delay(VIEWING_MIN_GAP_MS)
            synchronized(this@PresenceController) { viewingCooldown = null }
            push()
        }
    }

    private companion object {
        val UNSENT = Any()
        const val VIEWING_MIN_GAP_MS = 50L
    }
}
