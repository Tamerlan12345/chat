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

    private class Queue(count: Int, val failing: Boolean = false, known: Boolean = true) : OutgoingQueue {
        val calls = mutableListOf<String>()
        override val unsentCount: StateFlow<Int> = MutableStateFlow(count)
        override val unsentKnown: StateFlow<Boolean> = MutableStateFlow(known)
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

    // ── Fix round 4 (2): a sign-out that was called off leaves the same account working ─────────

    private val conv = "direct:7"

    private fun echo(id: Long, key: String) = kotlinx.serialization.json.buildJsonObject {
        put("type", kotlinx.serialization.json.JsonPrimitive("direct_message"))
        put("message", kotlinx.serialization.json.buildJsonObject {
            put("id", kotlinx.serialization.json.JsonPrimitive(id))
            put("conversation_type", kotlinx.serialization.json.JsonPrimitive("direct"))
            put("target_id", kotlinx.serialization.json.JsonPrimitive(7))
            put("sender_id", kotlinx.serialization.json.JsonPrimitive(1))
            put("text", kotlinx.serialization.json.JsonPrimitive("эхо"))
            put("type", kotlinx.serialization.json.JsonPrimitive("text"))
            put("created_at", kotlinx.serialization.json.JsonPrimitive("2026-10-05T09:00:00.000Z"))
            put("is_deleted", kotlinx.serialization.json.JsonPrimitive(0))
            put("client_msg_id", kotlinx.serialization.json.JsonPrimitive(key))
        })
    }

    private fun incoming(id: Long) = kotlinx.serialization.json.buildJsonObject {
        put("type", kotlinx.serialization.json.JsonPrimitive("new_message"))
        put("message", kotlinx.serialization.json.buildJsonObject {
            put("id", kotlinx.serialization.json.JsonPrimitive(id))
            put("conversation_type", kotlinx.serialization.json.JsonPrimitive("direct"))
            put("target_id", kotlinx.serialization.json.JsonPrimitive(1))
            put("sender_id", kotlinx.serialization.json.JsonPrimitive(7))
            put("text", kotlinx.serialization.json.JsonPrimitive("входящее"))
            put("type", kotlinx.serialization.json.JsonPrimitive("text"))
            put("created_at", kotlinx.serialization.json.JsonPrimitive("2026-10-05T09:01:00.000Z"))
            put("is_deleted", kotlinx.serialization.json.JsonPrimitive(0))
            put("client_msg_id", kotlinx.serialization.json.JsonPrimitive("in-$id"))
        })
    }

    private suspend fun kotlinx.coroutines.test.TestScope.assertTheAccountWorks(h: com.openmychat.mobile.testing.DeliveryHarness) {
        val outcome = h.engine.enqueue(conv, "после отмены выхода", clientMsgId = "k2")
        runCurrent()
        assertTrue("an enqueue is taken again", outcome.composerCleared)
        assertTrue("and goes out over the open socket", "k2" in realtime.sentClientMsgIds)
        realtime.emitFrame(echo(51, "k2"))
        realtime.emitFrame(incoming(52))
        runCurrent()
        assertTrue("its confirmation is taken", h.engine.state.value.outbox.none { it.clientMsgId == "k2" })
        assertTrue("incoming frames are taken", h.engine.state.value.messages[conv].orEmpty().any { it.id == 52L })
    }

    @Test
    fun aSignOutWhoseDeleteFailedLeavesTheAccountWorkingWithItsMessages() = runTest(dispatcher) {
        var clearFailures = 0
        val store = object : com.openmychat.mobile.testing.InMemoryDeliveryStore() {
            override suspend fun clear() {
                if (clearFailures-- > 0) throw java.io.IOException("disk")
                super.clear()
            }
        }
        realtime.connectionState.value = com.openmychat.mobile.core.network.ConnectionState.Connecting
        val h = com.openmychat.mobile.testing.DeliveryHarness(realtime, null, dispatcher, store = store)
        runCurrent()
        assertTrue(h.engine.enqueue(conv, "не отправлено", clientMsgId = "k1").composerCleared)
        realtime.connectionState.value = com.openmychat.mobile.core.network.ConnectionState.Connected
        runCurrent()
        val vm = viewModel(h.runtime)
        var navigated = false
        clearFailures = 1 // the sign-out's delete fails

        vm.logout { navigated = true }
        runCurrent()

        assertFalse(navigated)
        assertEquals(0, auth.loggedOut)
        assertTrue(vm.logoutError.value != null)
        assertEquals("the message the screen said was not deleted is still there", listOf("k1"), h.engine.state.value.outbox.map { it.clientMsgId })
        assertEquals(listOf("k1"), store.stored.outbox.map { it.clientMsgId })
        assertEquals("and it goes out again (same key)", listOf("k1", "k1"), realtime.sentClientMsgIds)
        realtime.emitFrame(echo(50, "k1"))
        runCurrent()
        assertTrue(store.stored.outbox.isEmpty())
        assertTheAccountWorks(h)
        h.stop()
    }

    @Test
    fun aSignOutTheSessionRefusedLeavesTheAccountWorking() = runTest(dispatcher) {
        val refusing = object : com.openmychat.mobile.data.repository.AuthRepository by FakeAuthRepository() {
            // The session could not be cleared at all: it is still there.
            override val hasSessionToken: Boolean = true
            override suspend fun logout() = throw com.openmychat.mobile.core.session.SecureStorageUnavailableException()
        }
        val h = com.openmychat.mobile.testing.DeliveryHarness(realtime, null, dispatcher)
        runCurrent()
        val vm = ProfileViewModel(Profiles(me), refusing, realtime, PresenceController(realtime, backgroundScope), h.runtime)
        var navigated = false

        vm.logout { navigated = true }
        runCurrent()

        assertFalse(navigated)
        assertTrue(vm.logoutError.value != null)
        assertTheAccountWorks(h)
        h.stop()
    }
    /** copy-ru.md signout.unsent_unknown: «0» before the queue is read would not be true. */
    @Test
    fun theConfirmationKnowsWhenTheUnsentCountIsNotKnownYet() = runTest(dispatcher) {
        assertFalse(viewModel(Queue(0, known = false)).unsentKnown.value)
        assertTrue(viewModel(Queue(0)).unsentKnown.value)
    }
}
