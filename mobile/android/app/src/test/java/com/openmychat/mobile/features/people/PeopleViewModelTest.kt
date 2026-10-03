package com.openmychat.mobile.features.people

import com.openmychat.mobile.data.model.OrgDepartment
import com.openmychat.mobile.data.model.OrgTree
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.repository.PeopleRepository
import com.openmychat.mobile.data.repository.PeopleState
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class PeopleViewModelTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val tree = OrgTree(
        tree = listOf(
            OrgDepartment(id = 1, name = "Головной офис", subDepartments = listOf(OrgDepartment(id = 2, name = "Бухгалтерия"))),
            OrgDepartment(id = 3, name = "Склад")
        )
    )
    private val people = listOf(
        Person(id = 2, fullName = "Иванов Пётр", departmentId = 2, departmentName = "Бухгалтерия", status = UserStatus.ONLINE),
        Person(id = 3, fullName = "Абрамова Анна", departmentId = 3, departmentName = "Склад"),
        Person(id = 4, fullName = "Петрова Ивана", departmentId = 3, departmentName = "Склад", status = UserStatus.AWAY),
        Person(id = 5, fullName = "Сидоров Олег", departmentId = 2, departmentName = "Бухгалтерия", status = UserStatus.DND)
    )

    private class FakePeople(state: PeopleState) : PeopleRepository {
        override val state = MutableStateFlow(state)
        var refreshes = 0
        override fun refresh() {
            refreshes++
        }
        override suspend fun person(id: Long): Person? = null
    }

    private val repository = FakePeople(PeopleState(people = people, tree = tree, isLoaded = true))
    private val requests = PeopleRequests()
    private fun viewModel() = PeopleViewModel(repository, requests, FakeRealtimeRepository())

    @Test
    fun opensWithARefreshAndTheSummaryCountsEveryoneAndWhoIsOnline() {
        val vm = viewModel()
        assertEquals(1, repository.refreshes)
        assertEquals(4, vm.state.value.total)
        assertEquals("online + away", 2, vm.state.value.online)
        assertEquals(listOf("А", "И", "П", "С"), vm.state.value.sections.map { it.letter })
    }

    @Test
    fun typingRanksTheResultsInsteadOfTheSections() {
        val vm = viewModel()
        vm.setQuery("иван")
        assertTrue(vm.state.value.isSearching)
        assertEquals(emptyList<LetterSection>(), vm.state.value.sections)
        assertEquals(listOf(2L, 4L), vm.state.value.results.map { it.person.id })
    }

    @Test
    fun theOnlineFilterKeepsOnlineAndAwayButNotTheSummary() {
        val vm = viewModel()
        vm.toggleOnlineOnly()
        assertEquals(listOf(2L, 4L), vm.state.value.sections.flatMap { it.people }.map { it.id }.sorted())
        assertEquals(4, vm.state.value.total)

        vm.setScope(PeopleScope.DEPARTMENTS)
        assertEquals(listOf("Головной офис", "Склад"), vm.state.value.departments.map { it.name })
        assertEquals("ветки с теми, кто в сети, раскрыты", setOf(1L, 2L, 3L), vm.state.value.expanded)
    }

    @Test
    fun departmentsExpandOnTapAndSearchExpandsMatches() {
        val vm = viewModel()
        vm.setScope(PeopleScope.DEPARTMENTS)
        assertEquals("верхний уровень раскрыт, как на десктопе", setOf(1L, 3L), vm.state.value.expanded)
        vm.toggleDepartment(1)
        assertEquals(setOf(3L), vm.state.value.expanded)
        vm.toggleDepartment(2)
        assertEquals(setOf(2L, 3L), vm.state.value.expanded)

        vm.setQuery("сидор")
        assertEquals(setOf(1L, 2L), vm.state.value.expanded)
        assertEquals(listOf("Головной офис"), vm.state.value.departments.map { it.name })
    }

    @Test
    fun aSearchFromChatsArrivesWithItsQuery() {
        requests.send(PeopleRequest.Search("петр"))
        val vm = viewModel()
        assertEquals("петр", vm.state.value.query)
        assertEquals(PeopleScope.ALL, vm.state.value.scope)
        assertEquals(null, requests.pending.value)
    }

    @Test
    fun aDepartmentFromTheCardOpensItsBranch() {
        val vm = viewModel()
        vm.setQuery("что-то")
        vm.toggleOnlineOnly()
        requests.send(PeopleRequest.Department(2))
        assertEquals(PeopleScope.DEPARTMENTS, vm.state.value.scope)
        assertEquals("", vm.state.value.query)
        assertFalse(vm.state.value.onlineOnly)
        assertEquals(setOf(1L, 2L, 3L), vm.state.value.expanded)
    }

    @Test
    fun departmentCountersIncludeTheSignedInUserLikeTheDesktop() {
        repository.state.value = repository.state.value.copy(self = Person(id = 1, fullName = "Я Сам", departmentId = 3, status = UserStatus.ONLINE))
        val vm = viewModel()
        vm.setScope(PeopleScope.DEPARTMENTS)
        val sklad = vm.state.value.departments.first { it.name == "Склад" }
        assertEquals(3, sklad.total)
        assertEquals(2, sklad.online)
        assertEquals("в списке «Все» себя нет", 4, vm.state.value.total)
    }

    @Test
    fun filtersSurviveProcessDeath() {
        val saved = androidx.lifecycle.SavedStateHandle()
        val first = PeopleViewModel(repository, requests, FakeRealtimeRepository(), saved)
        first.setScope(PeopleScope.DEPARTMENTS)
        first.toggleOnlineOnly()
        first.setQuery("бух")

        val restored = PeopleViewModel(repository, PeopleRequests(), FakeRealtimeRepository(), saved)
        assertEquals("бух", restored.state.value.query)
        assertEquals(PeopleScope.DEPARTMENTS, restored.state.value.scope)
        assertTrue(restored.state.value.onlineOnly)
    }

    @Test
    fun nothingFoundIsAnEmptyResult() {
        val vm = viewModel()
        vm.setQuery("zzz")
        assertTrue(vm.state.value.isEmptyResult)
    }
}
