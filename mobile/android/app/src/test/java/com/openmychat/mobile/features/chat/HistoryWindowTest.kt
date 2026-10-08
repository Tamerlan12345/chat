package com.openmychat.mobile.features.chat

import com.openmychat.mobile.testing.message
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HistoryWindowTest {

    /** Переписка из сообщений с ид 1..[last]; запросы как у сервера (beforeId/afterId, limit). */
    private class Server(val last: Long) {
        val requests = mutableListOf<String>()
        suspend fun before(beforeId: Long, limit: Int) =
            (maxOf(1, beforeId - limit) until beforeId).map { message(it, 2, 1) }.also { requests += "before $beforeId $limit" }
        suspend fun after(afterId: Long, limit: Int) =
            ((afterId + 1)..minOf(last, afterId + limit)).map { message(it, 2, 1) }.also { requests += "after $afterId $limit" }
    }

    @Test
    fun theWindowHoldsTheMessageItsContextAndEverythingNewer() = runTest {
        val server = Server(last = 300)
        val window = HistoryWindow.around(100, server::before, server::after)!!
        assertEquals(70L, window.first().id)
        assertEquals(300L, window.last().id)
        assertEquals("непрерывно, без повторов", (70L..300L).toList(), window.map { it.id })
        assertEquals(listOf("before 101 31", "after 100 200", "after 300 200"), server.requests)
    }

    @Test
    fun tooManyNewerMessagesGiveUpInsteadOfLeavingAGap() = runTest {
        val server = Server(last = 5_000)
        assertNull(HistoryWindow.around(100, server::before, server::after))
    }

    @Test
    fun aMessageThatIsGoneGivesUp() = runTest {
        val window = HistoryWindow.around(
            messageId = 50,
            before = { _, _ -> listOf(message(48, 2, 1), message(49, 2, 1)) },
            after = { _, _ -> emptyList() }
        )
        assertNull(window)
    }
}
