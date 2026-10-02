package com.openmychat.mobile.features.profile

import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.realtime.Presence
import com.openmychat.mobile.data.realtime.PresenceController
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
import org.junit.Assert.assertTrue
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

    private val realtime = FakeRealtimeRepository()

    private fun kotlinx.coroutines.test.TestScope.viewModel(profiles: ProfileRepository) =
        ProfileViewModel(profiles, FakeAuthRepository(), realtime, PresenceController(realtime, backgroundScope))

    @Test
    fun aFailedSaveIsReported() = runTest(dispatcher) {
        val vm = viewModel(Profiles(me, fail = true))
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
        val vm = viewModel(Profiles(me, fail = false))
        runCurrent()
        vm.updateCustomStatusInput("На встрече")

        val event = backgroundScope.async { vm.events.first() }
        vm.saveCustomStatus()
        runCurrent()

        assertEquals(ProfileEvent.StatusSaved, event.await())
        // Свой статус уходит с автоматическим присутствием, без стирания и без ручного статуса.
        assertEquals(listOf("presence online custom=На встрече"), realtime.sent)
    }

    @Test
    fun doNotDisturbIsTheOnlyManualStatus() = runTest(dispatcher) {
        val vm = viewModel(Profiles(me, fail = false))
        runCurrent()
        assertFalse(vm.dnd.value)

        vm.setDnd(true)
        vm.setDnd(true)
        assertTrue(vm.dnd.value)
        vm.setDnd(false)
        assertFalse(vm.dnd.value)
        assertEquals(listOf("set_dnd true", "set_dnd false"), realtime.sent)
        // «В сети» / «Отошёл» не выбираются: показ возвращается к автоматическому присутствию.
        assertEquals(Presence.ONLINE, vm.presence.value)
    }

    @Test
    fun theServerConfirmationOfDndReachesTheSwitch() = runTest(dispatcher) {
        val vm = viewModel(Profiles(me, fail = false))
        runCurrent()
        realtime.emit(WsEvent.UserStatusChanged(userId = me.id, status = UserStatus.DND, customStatus = null))
        runCurrent()
        assertTrue(vm.dnd.value)
        realtime.emit(WsEvent.UserStatusChanged(userId = me.id, status = UserStatus.AWAY, customStatus = null))
        runCurrent()
        assertFalse(vm.dnd.value)
    }
}
