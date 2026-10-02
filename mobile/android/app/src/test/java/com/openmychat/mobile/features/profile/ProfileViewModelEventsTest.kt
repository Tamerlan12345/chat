package com.openmychat.mobile.features.profile

import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.repository.ProfileRepository
import com.openmychat.mobile.testing.FakeAuthRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test

/** Saving the custom status reports its outcome instead of failing silently. */
class ProfileViewModelEventsTest {

    private val dispatcher = StandardTestDispatcher()

    @get:Rule val mainDispatcher = MainDispatcherRule(dispatcher)

    private val me = User(id = 1, username = "alice", fullName = "Алиса Тестова")

    private class Profiles(val user: User, var fail: Boolean) : ProfileRepository {
        override val cachedUser: User? = user
        override suspend fun me(): User = user
        override suspend fun updateCustomStatus(customStatus: String?): User {
            if (fail) error("offline")
            return user.copy(customStatus = customStatus)
        }
        override fun storeUser(user: User) = Unit
    }

    @Test
    fun aFailedSaveIsReported() = runTest(dispatcher) {
        val vm = ProfileViewModel(Profiles(me, fail = true), FakeAuthRepository(), FakeRealtimeRepository())
        runCurrent()
        vm.updateCustomStatusInput("На встрече")

        val event = backgroundScope.async { vm.events.first() }
        vm.saveCustomStatus()
        runCurrent()

        assertEquals(ProfileEvent.StatusSaveFailed, event.await())
        assertFalse(vm.uiState.value.isSaving)
    }

    @Test
    fun aSuccessfulSaveIsConfirmed() = runTest(dispatcher) {
        val vm = ProfileViewModel(Profiles(me, fail = false), FakeAuthRepository(), FakeRealtimeRepository())
        runCurrent()
        vm.updateCustomStatusInput("На встрече")

        val event = backgroundScope.async { vm.events.first() }
        vm.saveCustomStatus()
        runCurrent()

        assertEquals(ProfileEvent.StatusSaved, event.await())
    }
}
