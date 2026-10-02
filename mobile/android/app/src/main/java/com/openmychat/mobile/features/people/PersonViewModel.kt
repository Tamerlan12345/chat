package com.openmychat.mobile.features.people

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.RolePermissions
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
 * отдаёт права коллег), а собеседник должен быть на связи. «Не беспокоить» не мешает: человек в
 * сети и сам решит, отвечать ли.
 */
enum class CallAvailability {
    AVAILABLE,

    /** «Звонки недоступны»: роли текущего сотрудника звонки не разрешены. */
    NOT_PERMITTED,

    /** «Не в сети»: звонок некуда доставить. */
    PEER_OFFLINE;

    companion object {
        fun of(myPermissions: RolePermissions?, peerStatus: UserStatus): CallAvailability = when {
            myPermissions != null && !myPermissions.canCall -> NOT_PERMITTED
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
    val wakeCooldown: Int = 0
)

@HiltViewModel(assistedFactory = PersonViewModel.Factory::class)
class PersonViewModel @AssistedInject constructor(
    @Assisted val userId: Long,
    private val people: PeopleRepository,
    private val session: SessionRepository,
    private val realtime: RealtimeRepository
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

    init {
        viewModelScope.launch {
            combine(people.state, session.currentUser, wakeCooldown) { directory, me, cooldown ->
                val person = if (isSelf) me?.let { Person.from(it) } else directory.people.firstOrNull { it.id == userId }
                PersonCardState(
                    person = person ?: _state.value.person,
                    isSelf = isSelf,
                    call = CallAvailability.of(me?.permissions, person?.status ?: UserStatus.OFFLINE),
                    wakeCooldown = cooldown
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
