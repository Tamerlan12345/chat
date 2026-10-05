package com.openmychat.mobile.features.profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.data.delivery.OutgoingQueue
import com.openmychat.mobile.data.repository.AccountRepository
import com.openmychat.mobile.features.account.AccountFailure
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class DeleteAccountState(
    /** Memory only; dropped once the account is gone. */
    val password: String = "",
    val deleting: Boolean = false,
    val failure: AccountFailure? = null,
    /** The server deleted the account and this device is wiped: the screen goes to sign-in. */
    val deleted: Boolean = false
) {
    val canDelete: Boolean get() = password.isNotEmpty() && !deleting && !deleted

    /** [canDelete], and the server's wait (429) is over at [now] (or there is none). */
    fun canDeleteAt(now: Long): Boolean = canDelete && failure?.retryDeadline?.let { now < it } != true
}

/** «Удалить аккаунт»: the password again, an irreversible warning, then `DELETE /api/users/me`. */
@HiltViewModel
class DeleteAccountViewModel(
    private val account: AccountRepository,
    /** The account's unsent messages: they go with it. */
    private val outgoing: OutgoingQueue = OutgoingQueue.None,
    private val clock: () -> Long
) : ViewModel() {

    @Inject
    constructor(account: AccountRepository, outgoing: OutgoingQueue) : this(account, outgoing, System::currentTimeMillis)

    /** How many unsent messages the deletion also deletes (the confirmation says so). */
    val unsentCount: StateFlow<Int> get() = outgoing.unsentCount

    private val _state = MutableStateFlow(DeleteAccountState())
    val state: StateFlow<DeleteAccountState> = _state.asStateFlow()

    /** A new password clears the old error, but not a wait the server asked for. */
    fun onPasswordChange(value: String) =
        _state.update { it.copy(password = value, failure = it.failure as? AccountFailure.Throttled) }

    fun delete() {
        val current = _state.value
        if (!current.canDeleteAt(clock())) return
        _state.update { it.copy(deleting = true, failure = null) }
        viewModelScope.launch {
            try {
                // Once the server deleted the account, its unsent messages, cache and kept files go too —
                // whatever happens to the local session clear after it. Best effort: a failed local
                // wipe is retried by the delivery engine (and logged).
                account.deleteAccount(current.password) {
                    try {
                        outgoing.discardForSignOut()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                    }
                }
                _state.update { it.copy(deleting = false, deleted = true, password = "") }
            } catch (error: CancellationException) {
                _state.update { it.copy(deleting = false) }
                throw error
            } catch (error: Exception) {
                val failure = AccountFailure.from(error, AccountFailure.Context.DELETE_ACCOUNT, clock())
                _state.update { it.copy(deleting = false, failure = failure) }
            }
        }
    }
}
