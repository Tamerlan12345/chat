package com.openmychat.mobile.features.search

import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.InMemorySharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Test

class RecentsStoreTest {

    private fun person(id: Long) = RecentItem(RecentItem.Kind.PERSON, id, "Человек $id")

    @Test
    fun newestFirstWithoutDuplicatesAndAtMostFive() {
        var list = emptyList<RecentItem>()
        (1L..6L).forEach { list = list.withRecent(person(it)) }
        assertEquals(listOf(6L, 5L, 4L, 3L, 2L), list.map { it.id })

        list = list.withRecent(person(3))
        assertEquals(listOf(3L, 6L, 5L, 4L, 2L), list.map { it.id })

        // Канал и человек с одним ид — разные записи.
        list = list.withRecent(RecentItem(RecentItem.Kind.CHANNEL, 3, "Общий"))
        assertEquals(listOf(RecentItem.Kind.CHANNEL, RecentItem.Kind.PERSON), list.take(2).map { it.kind })
    }

    @Test
    fun recentsSurviveARestartAndVanishOnSignOut() {
        val prefs = InMemorySharedPreferences()
        val session = FakeSessionRepository()
        SharedPreferencesRecentsStore(prefs, session).add(person(7))

        val restarted = SharedPreferencesRecentsStore(prefs, session)
        assertEquals(listOf(7L), restarted.items.value.map { it.id })

        session.token.value = null
        assertEquals(emptyList<RecentItem>(), restarted.items.value)
        assertEquals(emptyList<RecentItem>(), SharedPreferencesRecentsStore(prefs, FakeSessionRepository()).items.value)
    }
}
