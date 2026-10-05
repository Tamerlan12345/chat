package com.openmychat.mobile.features.profile

import com.openmychat.mobile.data.delivery.OutgoingQueue
import com.openmychat.mobile.testing.FakeAccountRepository
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Review fix (ii): a deleted account's unsent messages, cache and kept files go with it. */
class DeleteAccountUnsentTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val account = FakeAccountRepository()

    private class Queue(count: Int, private val failing: Boolean = false) : OutgoingQueue {
        var discarded = 0
        override val unsentCount: StateFlow<Int> = MutableStateFlow(count)
        override suspend fun discardForSignOut() {
            discarded++
            if (failing) throw java.io.IOException("disk")
        }
    }

    @Test
    fun theConfirmationKnowsHowManyUnsentMessagesGoWithTheAccount() {
        assertEquals(4, DeleteAccountViewModel(account, Queue(4)) { 0L }.unsentCount.value)
    }

    @Test
    fun aDeletedAccountsUnsentMessagesAreDeletedToo() {
        val queue = Queue(2)
        val vm = DeleteAccountViewModel(account, queue) { 0L }
        vm.onPasswordChange("secret")

        vm.delete()

        assertTrue(vm.state.value.deleted)
        assertEquals(1, queue.discarded)
    }

    @Test
    fun theAccountIsGoneEvenIfTheLocalDeletionHasToBeRetried() {
        val queue = Queue(2, failing = true)
        val vm = DeleteAccountViewModel(account, queue) { 0L }
        vm.onPasswordChange("secret")

        vm.delete()

        assertTrue("the server deleted it: the screen moves on (the engine retries the wipe)", vm.state.value.deleted)
        assertEquals(1, queue.discarded)
    }

    @Test
    fun aLocalSessionClearThatFailsStillDeletesTheUnsentMessages() {
        // Review fix round 3: the server deleted the account; the secure storage then refused to
        // clear the session — the account's messages and files must go anyway.
        val queue = Queue(2)
        account.onLocalClear = { throw com.openmychat.mobile.core.session.SecureStorageUnavailableException() }
        val vm = DeleteAccountViewModel(account, queue) { 0L }
        vm.onPasswordChange("secret")

        vm.delete()

        assertEquals(1, queue.discarded)
        assertTrue("the storage problem is still reported", vm.state.value.failure != null)
    }

    @Test
    fun aRefusedDeletionKeepsTheUnsentMessages() {
        val queue = Queue(2)
        account.onDelete = { throw com.openmychat.mobile.core.network.ApiException(401, null, "Неверный пароль") }
        val vm = DeleteAccountViewModel(account, queue) { 0L }
        vm.onPasswordChange("wrong")

        vm.delete()

        assertEquals(0, queue.discarded)
    }
}
