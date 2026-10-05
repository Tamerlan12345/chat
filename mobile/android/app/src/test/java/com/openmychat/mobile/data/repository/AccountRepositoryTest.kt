package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.testing.FakeLoginPreferences
import com.openmychat.mobile.testing.TestSessions
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class AccountRepositoryTest {

    private val prefs = com.openmychat.mobile.testing.InMemorySharedPreferences()
    private val session = com.openmychat.mobile.core.session.SessionManager(prefs = prefs, serverEndpoint = TestSessions.CHAT_EXAMPLE).apply {
        saveAuthSuccess(User(id = 1, username = "alice", fullName = "Alice"), "token")
        deviceSecret = "device-secret"
    }
    private val preferences = FakeLoginPreferences().apply { lastUsername = "alice" }
    private val answers = ArrayDeque<Pair<Int, String>>()
    private val paths = mutableListOf<String>()

    private val api = ApiClient(session, OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
        paths += "${chain.request().method} ${chain.request().url.encodedPath}"
        val (code, body) = answers.removeFirstOrNull() ?: (200 to """{"success":true}""")
        Response.Builder()
            .request(chain.request())
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("x")
            .body(body.toResponseBody())
            .build()
    }).build())

    /** The repository once the block list load of its open session is done; that request is not part of each test. */
    private suspend fun TestScope.repository(): DefaultAccountRepository {
        val repository = DefaultAccountRepository(api, session, preferences, backgroundScope)
        runCurrent()
        repository.sessionLoad?.join()
        paths.clear()
        return repository
    }

    @Test
    fun aSessionLoadsTheBlockListAtStartAndAfterEverySignIn() = runTest {
        // A block made before this start (or on another device) is known without opening the profile.
        answers += 200 to """{"blocks":[{"userId":7,"displayName":"Боб"}]}"""
        val repository = DefaultAccountRepository(api, session, preferences, backgroundScope)
        runCurrent()
        repository.sessionLoad?.join()
        assertEquals(listOf(BlockedUser(7, "Боб")), repository.blocked.value)

        session.token = "rotated-token" // a refreshed token is the same session: no second request
        runCurrent()
        assertEquals(listOf("GET /api/blocks"), paths)

        session.clearSession()
        runCurrent()
        assertEquals(emptyList<BlockedUser>(), repository.blocked.value)

        answers += 200 to """{"blocks":[{"userId":8,"displayName":"Ева"}]}"""
        session.saveAuthSuccess(User(id = 1, username = "alice", fullName = "Alice"), "token-2")
        runCurrent()
        repository.sessionLoad?.join()
        assertEquals(listOf(BlockedUser(8, "Ева")), repository.blocked.value)
        assertEquals(listOf("GET /api/blocks", "GET /api/blocks"), paths)
    }

    @Test
    fun aBlockListThatCannotLoadLeavesTheListEmptyAndTheSessionAlone() = runTest {
        answers += 500 to """{"error":"x"}"""
        val repository = DefaultAccountRepository(api, session, preferences, backgroundScope)
        runCurrent()
        repository.sessionLoad?.join()

        assertEquals(emptyList<BlockedUser>(), repository.blocked.value)
        assertNotNull(session.token)
    }

    @Test
    fun deletingTheAccountWipesEverythingStoredOnThisDevice() = runTest(UnconfinedTestDispatcher()) {
        repository().deleteAccount("Secret-12")

        assertEquals(listOf("DELETE /api/users/me"), paths)
        assertNull(session.token)
        assertNull(session.currentUser)
        assertNull("the server unbound the device", session.deviceSecret)
        assertNull("nothing remembers the deleted login", preferences.lastUsername)
    }

    @Test
    fun whatFollowsTheServersDeletionRunsBeforeTheLocalClearCanFail() = runTest(UnconfinedTestDispatcher()) {
        var tokenWhenCalled: String? = "not called"
        repository().deleteAccount("Secret-12") { tokenWhenCalled = session.token }

        assertNotNull("ran right after the server deleted the account, before the local clear", tokenWhenCalled)
        assertNull(session.token)
    }

    @Test
    fun aRefusedDeletionLeavesTheSessionAlone() = runTest(UnconfinedTestDispatcher()) {
        val repository = repository()
        answers += 403 to """{"error":"Неверный пароль"}"""

        var followed = false
        try {
            repository.deleteAccount("wrong") { followed = true }
            fail("a wrong password must fail")
        } catch (error: ApiException) {
            assertEquals(403, error.statusCode)
        }

        assertEquals("nothing follows a refused deletion", false, followed)
        assertNotNull(session.token)
        assertEquals("device-secret", session.deviceSecret)
        assertEquals("alice", preferences.lastUsername)
    }

    @Test
    fun theBlockListFollowsBlocksAndUnblocks() = runTest(UnconfinedTestDispatcher()) {
        val repository = repository()
        answers += 200 to """{"blocks":[{"userId":7,"displayName":"Боб"}]}"""
        repository.refreshBlocked()
        assertEquals(listOf(BlockedUser(7, "Боб")), repository.blocked.value)

        answers += 201 to """{"userId":8}"""
        repository.block(8, "Ева")
        repository.block(8, "Ева") // repeated: the server answers 201 again, the list does not grow
        assertEquals(listOf(BlockedUser(7, "Боб"), BlockedUser(8, "Ева")), repository.blocked.value)

        repository.unblock(7)
        assertEquals(listOf(BlockedUser(8, "Ева")), repository.blocked.value)
        assertEquals(listOf("GET /api/blocks", "POST /api/blocks", "POST /api/blocks", "DELETE /api/blocks/7"), paths)
    }

    @Test
    fun aFailedBlockChangesNothing() = runTest(UnconfinedTestDispatcher()) {
        val repository = repository()
        answers += 404 to """{"error":"Не найден"}"""

        try {
            repository.block(99, "Никто")
            fail("must fail")
        } catch (_: ApiException) {
        }

        assertEquals(emptyList<BlockedUser>(), repository.blocked.value)
    }

    @Test
    fun signingOutForgetsTheBlockList() = runTest {
        // A standard dispatcher: the request hops to Dispatchers.IO and must come back to the test thread.
        val repository = repository()
        repository.block(8, "Ева")

        session.clearSession()
        runCurrent()

        assertEquals(emptyList<BlockedUser>(), repository.blocked.value)
    }

    @Test
    fun aLocalWipeThatFailsAfterTheServersDeletionSaysTheStorageIsUnavailable() = runTest(UnconfinedTestDispatcher()) {
        val repository = repository()
        var followed = false
        try {
            repository.deleteAccount("Secret-12") {
                followed = true
                prefs.failCommits = true // the keystore locks before the local clear
            }
            fail("a local wipe that failed must be reported")
        } catch (_: com.openmychat.mobile.core.session.SecureStorageUnavailableException) {
        }

        assertEquals(listOf("DELETE /api/users/me"), paths)
        assertEquals("what follows the deletion still ran", true, followed)
        assertNull("the session is still cleared from memory", session.token)
    }

    @Test
    fun deletingTheAccountWipesTheCachedPeopleDirectory() = runTest(UnconfinedTestDispatcher()) {
        val cache = object : PeopleCache {
            var stored: CachedPeople? = CachedPeople(ownerId = 1, savedAt = 1, people = listOf(com.openmychat.mobile.features.people.Person(id = 2, fullName = "Боб")))
            override suspend fun read(): CachedPeople? = stored
            override suspend fun write(value: CachedPeople) { stored = value }
            override suspend fun clear() { stored = null }
        }
        val source = object : PeopleSource {
            override suspend fun users(): List<User> = emptyList()
            override suspend fun orgTree() = com.openmychat.mobile.data.model.OrgTree()
            override suspend fun user(id: Long): User = error("unused")
        }
        DefaultPeopleRepository(source, cache, com.openmychat.mobile.testing.FakeRealtimeRepository(), DefaultSessionRepository(session), backgroundScope) { 0L }
        val repository = repository()

        repository.deleteAccount("Secret-12")
        // The HTTP call resumes off the test thread: wait (real time, bounded) for the directory's collector.
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
            kotlinx.coroutines.withTimeoutOrNull(2_000) { while (cache.stored != null) kotlinx.coroutines.delay(10) }
        }

        assertNull("the deleted account's colleagues are gone from this device", cache.stored)
    }
}
