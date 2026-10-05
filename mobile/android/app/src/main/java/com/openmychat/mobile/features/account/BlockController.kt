package com.openmychat.mobile.features.account

import com.openmychat.mobile.data.repository.AccountRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** One-off outcome of a block or unblock, for a snackbar. */
sealed interface SafetyNotice {
    data object Blocked : SafetyNotice
    data object Unblocked : SafetyNotice
    data class Failed(val failure: AccountFailure) : SafetyNotice
}

/**
 * «Заблокировать» / «Разблокировать» one person (`POST` / `DELETE /api/blocks`), shared by the person
 * card and the direct chat. [blocked] follows the app-wide block list, so a block made in one place
 * shows everywhere.
 */
class BlockController(
    private val account: AccountRepository,
    private val scope: CoroutineScope,
    private val userId: Long,
    private val clock: () -> Long = System::currentTimeMillis
) {
    val blocked: StateFlow<Boolean> = account.blocked
        .map { list -> list.any { it.id == userId } }
        .stateIn(scope, SharingStarted.Eagerly, account.blocked.value.any { it.id == userId })

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _notice = MutableStateFlow<SafetyNotice?>(null)
    val notice: StateFlow<SafetyNotice?> = _notice.asStateFlow()

    fun block(name: String?) = run(SafetyNotice.Blocked) { account.block(userId, name) }

    fun unblock() = run(SafetyNotice.Unblocked) { account.unblock(userId) }

    fun noticeShown() {
        _notice.value = null
    }

    private fun run(success: SafetyNotice, request: suspend () -> Unit) {
        if (_busy.value) return
        _busy.value = true
        scope.launch {
            _notice.value = try {
                request()
                success
            } catch (error: Exception) {
                SafetyNotice.Failed(AccountFailure.from(error, AccountFailure.Context.GENERIC, clock()))
            }
            _busy.value = false
        }
    }
}
