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

    private val session = TestSessions.authenticated().apply { deviceSecret = "device-secret" }
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
    fun aRefusedDeletionLeavesTheSessionAlone() = runTest(UnconfinedTestDispatcher()) {
        val repository = repository()
        answers += 403 to """{"error":"Неверный пароль"}"""

        try {
            repository.deleteAccount("wrong")
            fail("a wrong password must fail")
        } catch (error: ApiException) {
            assertEquals(403, error.statusCode)
        }

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
}
