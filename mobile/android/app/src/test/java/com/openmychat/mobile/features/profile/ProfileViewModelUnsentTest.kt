package com.openmychat.mobile.features.profile

import com.openmychat.mobile.data.delivery.OutgoingQueue
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.realtime.PresenceController
import com.openmychat.mobile.data.repository.ProfileRepository
import com.openmychat.mobile.testing.FakeAuthRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Review fix 1c: an explicit sign-out says how many unsent messages it deletes, and deletes them first. */
class ProfileViewModelUnsentTest {

    private val dispatcher = StandardTestDispatcher()

    @get:Rule val mainDispatcher = MainDispatcherRule(dispatcher)

    private val me = User(id = 1, username = "alice", fullName = "Алиса Тестова")
    private val realtime = FakeRealtimeRepository()
    private val auth = object : com.openmychat.mobile.data.repository.AuthRepository by FakeAuthRepository() {
        var loggedOut = 0
        override suspend fun logout() {
            loggedOut++
        }
    }

    private class Queue(count: Int, val failing: Boolean = false) : OutgoingQueue {
        val calls = mutableListOf<String>()
        override val unsentCount: StateFlow<Int> = MutableStateFlow(count)
        override suspend fun discardForSignOut() {
            calls += "discard"
            if (failing) throw java.io.IOException("disk")
        }
    }

    private class Profiles(val user: User) : ProfileRepository {
        override val cachedUser: User? = user
        override suspend fun me(): User = user
        override suspend fun updateCustomStatus(customStatus: String?): User = user
        override fun storeUser(user: User) = Unit
    }

    private fun kotlinx.coroutines.test.TestScope.viewModel(queue: OutgoingQueue) =
        ProfileViewModel(Profiles(me), auth, realtime, PresenceController(realtime, backgroundScope), queue)

    @Test
    fun theConfirmationKnowsHowManyUnsentMessagesWouldBeDeleted() = runTest(dispatcher) {
        assertEquals(3, viewModel(Queue(3)).unsentCount.value)
    }

    @Test
    fun signingOutDeletesTheUnsentMessagesThenSignsOut() = runTest(dispatcher) {
        val queue = Queue(2)
        var navigated = false
        viewModel(queue).logout { navigated = true }
        runCurrent()

        assertEquals(listOf("discard"), queue.calls)
        assertEquals(1, auth.loggedOut)
        assertTrue(navigated)
    }

    @Test
    fun aDeletionThatFailsKeepsTheSessionAndSaysSo() = runTest(dispatcher) {
        val queue = Queue(2, failing = true)
        var navigated = false
        val vm = viewModel(queue)
        vm.logout { navigated = true }
        runCurrent()

        assertEquals(0, auth.loggedOut)
        assertFalse(navigated)
        assertTrue(vm.logoutError.value != null)
    }
}
