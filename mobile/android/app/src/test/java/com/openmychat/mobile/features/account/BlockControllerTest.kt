package com.openmychat.mobile.features.account

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.testing.FakeAccountRepository
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BlockControllerTest {

    private val account = FakeAccountRepository()

    @Test
    fun blockAndUnblockFollowTheSharedBlockList() = runTest(UnconfinedTestDispatcher()) {
        val blocks = BlockController(account, backgroundScope, userId = 8) { 0L }
        assertFalse(blocks.blocked.value)

        blocks.block("Ева")
        assertEquals(listOf("block 8"), account.blockCalls)
        assertTrue(blocks.blocked.value)
        assertEquals(SafetyNotice.Blocked, blocks.notice.value)
        blocks.noticeShown()
        assertNull(blocks.notice.value)

        blocks.unblock()
        assertFalse(blocks.blocked.value)
        assertEquals(SafetyNotice.Unblocked, blocks.notice.value)
    }

    @Test
    fun aBlockMadeElsewhereShowsHereToo() = runTest(UnconfinedTestDispatcher()) {
        val blocks = BlockController(account, backgroundScope, userId = 8) { 0L }

        account.blocked.value = listOf(BlockedUser(8, "Ева"))

        assertTrue(blocks.blocked.value)
    }

    @Test
    fun aFailureIsReportedAndChangesNothing() = runTest(UnconfinedTestDispatcher()) {
        account.onBlock = { throw ApiException(429, null, "Слишком часто", retryAfterSeconds = 10) }
        val blocks = BlockController(account, backgroundScope, userId = 8) { 1_000L }

        blocks.block("Ева")

        assertFalse(blocks.blocked.value)
        assertFalse(blocks.busy.value)
        assertEquals(SafetyNotice.Failed(AccountFailure.Throttled(11_000L)), blocks.notice.value)
    }

    @Test
    fun oneRequestAtATime() = runTest(UnconfinedTestDispatcher()) {
        val gate = CompletableDeferred<Unit>()
        account.onBlock = { gate.await() }
        val blocks = BlockController(account, backgroundScope, userId = 8) { 0L }

        blocks.block("Ева")
        assertTrue(blocks.busy.value)
        blocks.block("Ева")
        blocks.unblock()
        gate.complete(Unit)

        assertEquals(listOf("block 8"), account.blockCalls)
        assertFalse(blocks.busy.value)
    }
}
