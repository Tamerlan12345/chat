package com.openmychat.mobile.features.profile

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.features.account.AccountFailure
import com.openmychat.mobile.testing.FakeAccountRepository
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class AccountSafetyViewModelsTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val account = FakeAccountRepository()

    // --- deletion --------------------------------------------------------------------------------

    @Test
    fun deletionNeedsAPasswordAndReportsSuccessOnce() = runTest {
        val vm = DeleteAccountViewModel(account) { 0L }
        assertFalse(vm.state.value.canDelete)
        vm.delete()
        assertTrue(account.deletions.isEmpty())

        vm.onPasswordChange("Secret-12")
        assertTrue(vm.state.value.canDelete)
        vm.delete()

        assertEquals(listOf("Secret-12"), account.deletions)
        assertTrue(vm.state.value.deleted)
        assertEquals("the password is not kept after deletion", "", vm.state.value.password)
    }

    @Test
    fun aWrongPasswordIsShownAndTheAccountStays() = runTest {
        account.onDelete = { throw ApiException(403, null, "Неверный пароль") }
        val vm = DeleteAccountViewModel(account) { 0L }
        vm.onPasswordChange("wrong")

        vm.delete()

        assertEquals(AccountFailure.WrongPassword, vm.state.value.failure)
        assertFalse(vm.state.value.deleted)
        assertFalse(vm.state.value.deleting)
    }

    @Test
    fun aSecondConfirmationWhileDeletingSendsNothing() = runTest {
        val gate = CompletableDeferred<Unit>()
        account.onDelete = { gate.await() }
        val vm = DeleteAccountViewModel(account) { 0L }
        vm.onPasswordChange("Secret-12")

        vm.delete()
        vm.delete()
        assertTrue(vm.state.value.deleting)
        assertFalse(vm.state.value.canDelete)
        gate.complete(Unit)

        assertEquals(1, account.deletions.size)
    }

    // --- blocked users ---------------------------------------------------------------------------

    @Test
    fun theBlockListLoadsAndUnblockRemovesAPerson() = runTest {
        account.onRefreshBlocked = { listOf(BlockedUser(7, "Боб"), BlockedUser(8, null)) }
        val vm = BlockedUsersViewModel(account) { 0L }

        assertEquals(listOf(BlockedUser(7, "Боб"), BlockedUser(8, null)), vm.state.value.blocked)
        assertTrue(vm.state.value.loaded)

        vm.unblock(7)

        assertEquals(listOf("unblock 7"), account.blockCalls)
        assertEquals(listOf(BlockedUser(8, null)), vm.state.value.blocked)
    }

    @Test
    fun aListThatCouldNotLoadSaysSo() = runTest {
        account.onRefreshBlocked = { throw ApiException(0, "NETWORK_ERROR", "offline") }
        val vm = BlockedUsersViewModel(account) { 0L }

        assertEquals(AccountFailure.Offline, vm.state.value.loadFailure)
        assertFalse(vm.state.value.loaded)

        account.onRefreshBlocked = { emptyList() }
        vm.refresh()
        assertNull(vm.state.value.loadFailure)
        assertTrue(vm.state.value.loaded)
    }

    @Test
    fun aFailedUnblockKeepsThePersonAndExplains() = runTest {
        account.blocked.value = listOf(BlockedUser(7, "Боб"))
        account.onUnblock = { throw ApiException(500, null, "x") }
        val vm = BlockedUsersViewModel(account) { 0L }

        vm.unblock(7)

        assertEquals(listOf(BlockedUser(7, "Боб")), vm.state.value.blocked)
        assertEquals(AccountFailure.Unavailable, vm.state.value.actionFailure)
        assertTrue(vm.state.value.busyIds.isEmpty())
    }
}
