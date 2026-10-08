package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.OrgDepartment
import com.openmychat.mobile.data.model.OrgTree
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.features.people.Person
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Справочник: мгновенно из кэша, обновление под ним (stale-while-revalidate), живой статус. */
@OptIn(ExperimentalCoroutinesApi::class)
class PeopleRepositoryTest {

    private class FakeSource : PeopleSource {
        var users: List<User> = emptyList()
        var tree: OrgTree = OrgTree()
        var gate: CompletableDeferred<Unit>? = null
        var failWith: Exception? = null
        var treeFailure: Exception? = null
        var requests = 0

        override suspend fun users(): List<User> {
            requests++
            gate?.await()
            failWith?.let { throw it }
            return users
        }

        override suspend fun orgTree(): OrgTree {
            treeFailure?.let { throw it }
            return tree
        }

        override suspend fun user(id: Long): User = users.first { it.id == id }
    }

    private class MemoryCache : PeopleCache {
        var stored: CachedPeople? = null
        override suspend fun read(): CachedPeople? = stored
        override suspend fun write(value: CachedPeople) {
            stored = value
        }
        override suspend fun clear() {
            stored = null
        }
    }

    private val source = FakeSource()
    private val cache = MemoryCache()
    private val realtime = FakeRealtimeRepository()
    private val session = FakeSessionRepository()

    private fun TestScope.repository(): DefaultPeopleRepository =
        DefaultPeopleRepository(source, cache, realtime, session, backgroundScope, clock = { 1_000L })

    private fun user(id: Long, name: String, status: UserStatus = UserStatus.OFFLINE, departmentId: Long? = null) =
        User(id = id, username = "u$id", fullName = name, status = status, departmentId = departmentId)

    @Test
    fun theCachedListShowsAtOnceAndTheServerReplacesIt() = runTest(UnconfinedTestDispatcher()) {
        cache.stored = CachedPeople(ownerId = FakeSessionRepository.ME, savedAt = 1, people = listOf(Person(id = 2, fullName = "Старый Список")))
        source.users = listOf(user(2, "Новый Список"))
        val gate = CompletableDeferred<Unit>()
        source.gate = gate

        val repo = repository()
        repo.refresh()
        assertEquals(listOf("Старый Список"), repo.state.value.people.map { it.fullName })
        assertTrue(repo.state.value.isRefreshing)

        gate.complete(Unit)
        assertEquals(listOf("Новый Список"), repo.state.value.people.map { it.fullName })
        assertFalse(repo.state.value.isRefreshing)
        assertEquals(listOf("Новый Список"), cache.stored?.people?.map { it.fullName })
    }

    @Test
    fun aFailedRefreshKeepsTheCacheAndSaysSo() = runTest(UnconfinedTestDispatcher()) {
        cache.stored = CachedPeople(ownerId = FakeSessionRepository.ME, savedAt = 1, people = listOf(Person(id = 2, fullName = "Кэш")))
        source.failWith = RuntimeException("offline")

        val repo = repository()
        repo.refresh()

        assertEquals(listOf("Кэш"), repo.state.value.people.map { it.fullName })
        assertTrue(repo.state.value.refreshFailed)
        assertTrue(repo.state.value.isLoaded)
    }

    @Test
    fun aFailureWithoutAnyDataIsAnError() = runTest(UnconfinedTestDispatcher()) {
        source.failWith = RuntimeException("offline")
        val repo = repository()
        repo.refresh()
        assertFalse(repo.state.value.isLoaded)
        assertTrue(repo.state.value.refreshFailed)
    }

    @Test
    fun anotherUsersCacheIsIgnored() = runTest(UnconfinedTestDispatcher()) {
        cache.stored = CachedPeople(ownerId = 99, savedAt = 1, people = listOf(Person(id = 2, fullName = "Чужой Кэш")))
        source.gate = CompletableDeferred()
        val repo = repository()
        repo.refresh()
        assertFalse(repo.state.value.isLoaded)
    }

    @Test
    fun theTreeIsOptionalAndNamesDepartments() = runTest(UnconfinedTestDispatcher()) {
        source.users = listOf(user(2, "Бух Галтер", departmentId = 5))
        source.tree = OrgTree(tree = listOf(OrgDepartment(id = 5, name = "Бухгалтерия")))
        val repo = repository()
        repo.refresh()
        assertEquals("Бухгалтерия", repo.state.value.people.single().departmentName)

        source.treeFailure = RuntimeException("tree down")
        source.users = listOf(user(2, "Бух Галтер", departmentId = 5), user(3, "Новый Коллега"))
        repo.refresh()
        assertEquals(2, repo.state.value.people.size)
        assertFalse("дерево — не главное: список обновился", repo.state.value.refreshFailed)
        assertEquals("прежнее дерево осталось", 1, repo.state.value.tree?.tree?.size)
    }

    @Test
    fun presenceChangesApplyLive() = runTest(UnconfinedTestDispatcher()) {
        source.users = listOf(user(2, "Коллега", status = UserStatus.ONLINE))
        val repo = repository()
        repo.refresh()

        realtime.emit(WsEvent.UserStatusChanged(userId = 2, status = UserStatus.AWAY, customStatus = "Обед"))
        assertEquals(UserStatus.AWAY, repo.state.value.people.single().status)
        assertEquals("Обед", repo.state.value.people.single().customStatus)

        realtime.emit(WsEvent.UserStatusChanged(userId = 2, status = UserStatus.OFFLINE, customStatus = null))
        val person = repo.state.value.people.single()
        assertEquals(UserStatus.OFFLINE, person.status)
        assertEquals("уход из сети — «был(а) в сети» сейчас", "1970-01-01T00:00:01Z", person.lastSeen)
    }

    @Test
    fun signingOutWipesTheListAndTheCache() = runTest(UnconfinedTestDispatcher()) {
        source.users = listOf(user(2, "Коллега"))
        val repo = repository()
        repo.refresh()
        assertTrue(cache.stored != null)

        session.token.value = null
        assertNull(cache.stored)
        assertEquals(emptyList<Person>(), repo.state.value.people)
        assertFalse(repo.state.value.isLoaded)
    }

    @Test
    fun aRepositoryCreatedAfterTheSessionEndedWipesTheStaleCache() = runTest(UnconfinedTestDispatcher()) {
        cache.stored = CachedPeople(ownerId = FakeSessionRepository.ME, savedAt = 1, people = listOf(Person(id = 2, fullName = "Кэш")))
        session.token.value = null // 401 или отозванный токен до первого открытия вкладки
        repository()
        assertNull(cache.stored)
    }

    @Test
    fun aClearedCustomStatusIsRemoved() = runTest(UnconfinedTestDispatcher()) {
        source.users = listOf(user(2, "Коллега", status = UserStatus.ONLINE).copy(customStatus = "Обед"))
        val repo = repository()
        repo.refresh()
        realtime.emit(WsEvent.UserStatusChanged(userId = 2, status = UserStatus.ONLINE, customStatus = null))
        assertNull(repo.state.value.people.single().customStatus)
        realtime.emit(WsEvent.UserStatusChanged(userId = 2, status = UserStatus.AWAY, customStatus = "Звонок"))
        realtime.emit(WsEvent.UserStatusChanged(userId = 2, status = UserStatus.ONLINE, customStatus = null, customStatusPresent = false))
        assertEquals("поля нет — свой статус прежний", "Звонок", repo.state.value.people.single().customStatus)
    }

    @Test
    fun theSignedInUserIsKeptApartForTheDepartmentCounters() = runTest(UnconfinedTestDispatcher()) {
        source.users = listOf(user(FakeSessionRepository.ME, "Я Сам", departmentId = 5), user(2, "Коллега", departmentId = 5))
        val repo = repository()
        repo.refresh()
        assertEquals(listOf(2L), repo.state.value.people.map { it.id })
        assertEquals(FakeSessionRepository.ME, repo.state.value.self?.id)
    }

    @Test
    fun concurrentRefreshesShareOneRequest() = runTest(UnconfinedTestDispatcher()) {
        source.gate = CompletableDeferred()
        val repo = repository()
        repo.refresh()
        repo.refresh()
        assertEquals(1, source.requests)
    }
}
