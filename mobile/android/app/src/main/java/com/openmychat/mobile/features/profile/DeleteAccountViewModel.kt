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

    fun onPasswordChange(value: String) = _state.update { it.copy(password = value, failure = null) }

    fun delete() {
        val current = _state.value
        if (!current.canDelete) return
        _state.update { it.copy(deleting = true, failure = null) }
        viewModelScope.launch {
            try {
                account.deleteAccount(current.password)
                // The account is gone on the server: its unsent messages, cache and kept files go too.
                // Best effort — a failed local wipe is retried by the delivery engine (and is logged).
                try {
                    outgoing.discardForSignOut()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                }
                _state.update { it.copy(deleting = false, deleted = true, password = "") }
            } catch (error: Exception) {
                val failure = AccountFailure.from(error, AccountFailure.Context.DELETE_ACCOUNT, clock())
                _state.update { it.copy(deleting = false, failure = failure) }
            }
        }
    }
}
