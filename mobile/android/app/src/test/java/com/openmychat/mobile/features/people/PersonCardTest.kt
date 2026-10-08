package com.openmychat.mobile.features.people

import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.data.model.OrgTree
import com.openmychat.mobile.data.model.ReportTargetType
import com.openmychat.mobile.features.account.ReportTarget
import com.openmychat.mobile.features.account.SafetyNotice
import com.openmychat.mobile.testing.FakeAccountRepository
import com.openmychat.mobile.data.model.RolePermissions
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.repository.PeopleRepository
import com.openmychat.mobile.data.repository.PeopleState
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class PersonCardTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    @Test
    fun callingNeedsOwnPermissionAndAReachablePeer() {
        val allowed = RolePermissions(canCall = true)
        assertEquals(CallAvailability.AVAILABLE, CallAvailability.of(allowed, UserStatus.ONLINE))
        assertEquals(CallAvailability.AVAILABLE, CallAvailability.of(allowed, UserStatus.AWAY))
        assertEquals("«не беспокоить» — сервер ответит call_unavailable", CallAvailability.PEER_DND, CallAvailability.of(allowed, UserStatus.DND))
        assertEquals(CallAvailability.PEER_OFFLINE, CallAvailability.of(allowed, UserStatus.OFFLINE))
        assertEquals(CallAvailability.NOT_PERMITTED, CallAvailability.of(RolePermissions(canCall = false), UserStatus.ONLINE))
        // Право важнее: «Звонки недоступны», даже если коллега не в сети.
        assertEquals(CallAvailability.NOT_PERMITTED, CallAvailability.of(RolePermissions(canCall = false), UserStatus.OFFLINE))
        assertEquals("право — раньше «не беспокоить»", CallAvailability.NOT_PERMITTED, CallAvailability.of(RolePermissions(canCall = false), UserStatus.DND))
        // Прав в сессии нет (старая запись) — решит сервер.
        assertEquals(CallAvailability.AVAILABLE, CallAvailability.of(null, UserStatus.ONLINE))
    }

    private class FakePeople(people: List<Person>) : PeopleRepository {
        override val state = MutableStateFlow(PeopleState(people = people, tree = OrgTree(), isLoaded = true))
        var fresh: Person? = null
        var gate: CompletableDeferred<Unit>? = null
        var refreshes = 0
        override fun refresh() {
            refreshes++
        }
        override suspend fun person(id: Long): Person? {
            gate?.await()
            fresh?.let { f -> state.value = state.value.copy(people = state.value.people.map { if (it.id == id) f else it }) }
            return fresh
        }
    }

    private val bob = Person(id = 8, fullName = "Боб Тестов", status = UserStatus.ONLINE, phone = "+7 700 000 00 00")

    @Test
    fun theCardShowsTheKnownPersonAtOnceAndRefreshesIt() {
        val people = FakePeople(listOf(bob))
        people.gate = CompletableDeferred()
        people.fresh = bob.copy(jobTitle = "Инженер")
        val vm = PersonViewModel(8, people, FakeSessionRepository(), FakeRealtimeRepository(), PeopleRequests())

        assertEquals("Боб Тестов", vm.state.value.person?.fullName)
        assertEquals(null, vm.state.value.person?.jobTitle)

        people.gate!!.complete(Unit)
        assertEquals("Инженер", vm.state.value.person?.jobTitle)
    }

    @Test
    fun presenceChangesReachTheOpenCard() {
        val people = FakePeople(listOf(bob))
        val vm = PersonViewModel(8, people, FakeSessionRepository(), FakeRealtimeRepository(), PeopleRequests())
        assertEquals(CallAvailability.AVAILABLE, vm.state.value.call)

        people.state.value = people.state.value.copy(people = listOf(bob.copy(status = UserStatus.OFFLINE)))
        assertEquals(CallAvailability.PEER_OFFLINE, vm.state.value.call)
    }

    @Test
    fun theCallerPermissionComesFromTheOwnSession() {
        val session = FakeSessionRepository()
        session.currentUser.value = User(id = FakeSessionRepository.ME, username = "me", fullName = "Я", permissions = RolePermissions(canCall = false))
        val vm = PersonViewModel(8, FakePeople(listOf(bob)), session, FakeRealtimeRepository(), PeopleRequests())
        assertEquals(CallAvailability.NOT_PERMITTED, vm.state.value.call)
    }

    @Test
    fun theOwnCardIsMarkedSoTheActionsBecomeEditProfile() {
        val session = FakeSessionRepository()
        session.currentUser.value = User(id = FakeSessionRepository.ME, username = "me", fullName = "Я Сам", jobTitle = "Аналитик")
        val vm = PersonViewModel(FakeSessionRepository.ME, FakePeople(emptyList()), session, FakeRealtimeRepository(), PeopleRequests())
        assertTrue(vm.state.value.isSelf)
        assertEquals("Я Сам", vm.state.value.person?.fullName)
        assertEquals("Аналитик", vm.state.value.person?.jobTitle)
    }

    @Test
    fun theDepartmentRowAsksThePeopleTabForThatBranch() {
        val requests = PeopleRequests()
        val vm = PersonViewModel(8, FakePeople(listOf(bob.copy(departmentId = 4))), FakeSessionRepository(), FakeRealtimeRepository(), requests)
        vm.showDepartment()
        assertEquals(PeopleRequest.Department(4), requests.pending.value)
    }

    @Test
    fun aFormerEmployeeIsShownAsInactive() {
        val people = FakePeople(emptyList())
        people.fresh = bob.copy(isActive = false)
        val vm = PersonViewModel(8, people, FakeSessionRepository(), FakeRealtimeRepository(), PeopleRequests())
        assertTrue(vm.state.value.inactive)
    }

    @Test
    fun wakingSendsOnceAndStartsTheCooldown() {
        val realtime = FakeRealtimeRepository()
        val vm = PersonViewModel(8, FakePeople(listOf(bob)), FakeSessionRepository(), realtime, PeopleRequests())
        vm.wake()
        vm.wake()
        assertEquals(listOf("wake_send 8"), realtime.sent)
        assertTrue(vm.state.value.wakeCooldown > 0)
    }

    // --- report and block (contracts/registration.md §4) -------------------------------------

    @Test
    fun theCardBlocksAndUnblocksThePerson() {
        val account = FakeAccountRepository()
        val vm = PersonViewModel(8, FakePeople(listOf(bob)), FakeSessionRepository(), FakeRealtimeRepository(), PeopleRequests(), account)
        assertFalse(vm.state.value.blocked)

        vm.block()

        assertEquals(listOf("block 8"), account.blockCalls)
        assertEquals(BlockedUser(8, "Боб Тестов"), account.blocked.value.single())
        assertTrue(vm.state.value.blocked)
        assertEquals(SafetyNotice.Blocked, vm.blocks.notice.value)

        vm.unblock()
        assertFalse(vm.state.value.blocked)
    }

    @Test
    fun reportingThePersonOpensTheSheetForThem() {
        val account = FakeAccountRepository()
        val vm = PersonViewModel(8, FakePeople(listOf(bob)), FakeSessionRepository(), FakeRealtimeRepository(), PeopleRequests(), account)

        vm.report()

        assertEquals(ReportTarget(ReportTargetType.USER, 8, "Боб Тестов"), vm.reports.sheet.value?.target)
    }

    @Test
    fun theOwnCardOffersNeitherReportNorBlock() {
        val account = FakeAccountRepository()
        val vm = PersonViewModel(FakeSessionRepository.ME, FakePeople(emptyList()), FakeSessionRepository(), FakeRealtimeRepository(), PeopleRequests(), account)

        vm.block()
        vm.report()

        assertTrue(account.blockCalls.isEmpty())
        assertNull(vm.reports.sheet.value)
    }
}
