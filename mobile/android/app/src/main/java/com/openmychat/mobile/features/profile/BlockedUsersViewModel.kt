package com.openmychat.mobile.features.profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.data.repository.AccountRepository
import com.openmychat.mobile.features.account.AccountFailure
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class BlockedUsersState(
    val blocked: List<BlockedUser> = emptyList(),
    /** The server's list arrived at least once. */
    val loaded: Boolean = false,
    val loading: Boolean = false,
    val loadFailure: AccountFailure? = null,
    /** An unblock that did not go through; shown until dismissed. */
    val actionFailure: AccountFailure? = null,
    val busyIds: Set<Long> = emptySet()
)

/** «Заблокированные пользователи» in the profile: the list from `GET /api/blocks`, each with «Разблокировать». */
@HiltViewModel
class BlockedUsersViewModel(
    private val account: AccountRepository,
    private val clock: () -> Long
) : ViewModel() {

    @Inject
    constructor(account: AccountRepository) : this(account, System::currentTimeMillis)

    private val _state = MutableStateFlow(BlockedUsersState(blocked = account.blocked.value))
    val state: StateFlow<BlockedUsersState> = _state.asStateFlow()

    init {
        viewModelScope.launch { account.blocked.collect { list -> _state.update { it.copy(blocked = list) } } }
        refresh()
    }

    fun refresh() {
        _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            try {
                account.refreshBlocked()
                _state.update { it.copy(loading = false, loaded = true, loadFailure = null) }
            } catch (error: Exception) {
                val failure = AccountFailure.from(error, AccountFailure.Context.GENERIC, clock())
                _state.update { it.copy(loading = false, loadFailure = failure) }
            }
        }
    }

    fun unblock(userId: Long) {
        if (userId in _state.value.busyIds) return
        _state.update { it.copy(busyIds = it.busyIds + userId, actionFailure = null) }
        viewModelScope.launch {
            val failure = try {
                account.unblock(userId)
                null
            } catch (error: Exception) {
                AccountFailure.from(error, AccountFailure.Context.GENERIC, clock())
            }
            _state.update { it.copy(busyIds = it.busyIds - userId, actionFailure = failure) }
        }
    }

    fun dismissFailure() = _state.update { it.copy(actionFailure = null) }
}
