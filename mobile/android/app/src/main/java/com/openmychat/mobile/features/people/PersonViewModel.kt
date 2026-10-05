package com.openmychat.mobile.features.people

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ReportTargetType
import com.openmychat.mobile.data.model.RolePermissions
import com.openmychat.mobile.data.repository.AccountRepository
import com.openmychat.mobile.data.repository.UnavailableAccountRepository
import com.openmychat.mobile.features.account.BlockController
import com.openmychat.mobile.features.account.ReportController
import com.openmychat.mobile.features.account.ReportTarget
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.repository.PeopleRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedFactory
import dagger.assisted.AssistedInject
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Можно ли позвонить из карточки. Право — своё (`can_call` текущего сотрудника: `/api/users` не
 * отдаёт права коллег), затем «Не беспокоить» (сервер отвечает call_unavailable), затем «не в сети».
 */
enum class CallAvailability {
    AVAILABLE,

    /** «Звонки недоступны»: роли текущего сотрудника звонки не разрешены. */
    NOT_PERMITTED,

    /** «Не беспокоить»: сервер не пропустит вызов. */
    PEER_DND,

    /** «Не в сети»: звонок некуда доставить. */
    PEER_OFFLINE;

    companion object {
        fun of(myPermissions: RolePermissions?, peerStatus: UserStatus): CallAvailability = when {
            myPermissions != null && !myPermissions.canCall -> NOT_PERMITTED
            peerStatus == UserStatus.DND -> PEER_DND
            peerStatus == UserStatus.OFFLINE -> PEER_OFFLINE
            else -> AVAILABLE
        }
    }
}

data class PersonCardState(
    val person: Person? = null,
    val isSelf: Boolean = false,
    val call: CallAvailability = CallAvailability.AVAILABLE,
    /** Секунды до следующей побудки; 0 — можно. */
    val wakeCooldown: Int = 0,
    /** Сотрудник в моём списке заблокированных. */
    val blocked: Boolean = false,
    /** Блокировка или разблокировка уходит на сервер. */
    val blockBusy: Boolean = false
) {
    /** Сотрудник больше не работает (карточка из старого чата): действия недоступны. */
    val inactive: Boolean get() = person?.isActive == false
}

@HiltViewModel(assistedFactory = PersonViewModel.Factory::class)
class PersonViewModel @AssistedInject constructor(
    @Assisted val userId: Long,
    private val people: PeopleRepository,
    private val session: SessionRepository,
    private val realtime: RealtimeRepository,
    private val requests: PeopleRequests,
    account: AccountRepository = UnavailableAccountRepository
) : ViewModel() {

    @AssistedFactory
    interface Factory {
        fun create(userId: Long): PersonViewModel
    }

    private val isSelf = userId == session.currentUserId
    private val wakeCooldown = MutableStateFlow(0)
    private var wakeTimer: Job? = null

    private val _state = MutableStateFlow(PersonCardState(isSelf = isSelf))
    val state: StateFlow<PersonCardState> = _state.asStateFlow()

    /** «Заблокировать» / «Разблокировать» этого сотрудника. */
    val blocks = BlockController(account, viewModelScope, userId)

    /** «Пожаловаться» на сотрудника: лист с причиной. */
    val reports = ReportController(account, viewModelScope)

    init {
        viewModelScope.launch {
            combine(people.state, session.currentUser, wakeCooldown, blocks.blocked, blocks.busy) { directory, me, cooldown, blocked, busy ->
                val person = if (isSelf) me?.let { Person.from(it) } else directory.people.firstOrNull { it.id == userId }
                PersonCardState(
                    person = person ?: _state.value.person,
                    isSelf = isSelf,
                    call = CallAvailability.of(me?.permissions, person?.status ?: UserStatus.OFFLINE),
                    wakeCooldown = cooldown,
                    blocked = blocked && !isSelf,
                    blockBusy = busy
                )
            }.collect { _state.value = it }
        }
        if (!isSelf) {
            viewModelScope.launch {
                // Свежие поля карточки (телефон, почта могли поменяться); справочник обновится тоже.
                val fresh = people.person(userId)
                if (fresh != null && people.state.value.people.none { it.id == userId }) {
                    _state.update { it.copy(person = fresh, call = CallAvailability.of(session.currentUser.value?.permissions, fresh.status)) }
                }
            }
            viewModelScope.launch {
                realtime.events.collect { event ->
                    if (event is WsEvent.WakeSent && event.targetUserId == userId) {
                        val remaining = ((event.retryAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0).toInt()
                        startCooldown(remaining.coerceAtLeast(WAKE_COOLDOWN_SECONDS))
                    }
                }
            }
        }
    }

    /** «Отдел» в карточке: «Сотрудники › Отделы» с раскрытой веткой этого отдела. */
    fun showDepartment() {
        val id = _state.value.person?.departmentId ?: return
        requests.send(PeopleRequest.Department(id))
    }

    fun block() {
        if (!isSelf) blocks.block(_state.value.person?.fullName)
    }

    fun unblock() {
        if (!isSelf) blocks.unblock()
    }

    fun report() {
        if (isSelf) return
        val name = _state.value.person?.fullName.orEmpty()
        reports.open(ReportTarget(ReportTargetType.USER, userId, name))
    }

    /** «Побудить»: сигнал и вибрация у коллеги; повторно — через минуту. */
    fun wake() {
        if (isSelf || wakeCooldown.value > 0) return
        realtime.sendWake(userId)
        startCooldown(WAKE_COOLDOWN_SECONDS)
    }

    private fun startCooldown(seconds: Int) {
        wakeTimer?.cancel()
        wakeCooldown.value = seconds
        wakeTimer = viewModelScope.launch {
            while (wakeCooldown.value > 0) {
                delay(1_000)
                wakeCooldown.value -= 1
            }
        }
    }

    private companion object {
        const val WAKE_COOLDOWN_SECONDS = 60
    }
}
