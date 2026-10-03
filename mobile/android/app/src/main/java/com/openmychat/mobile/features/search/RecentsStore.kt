package com.openmychat.mobile.features.search

import android.content.Context
import android.content.SharedPreferences
import com.openmychat.mobile.data.repository.SessionRepository
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

/** Кого или что открывали из поиска: человек или канал. */
@Serializable
data class RecentItem(
    @SerialName("kind") val kind: Kind,
    @SerialName("id") val id: Long,
    @SerialName("title") val title: String,
    @SerialName("avatar_url") val avatarUrl: String? = null
) {
    @Serializable
    enum class Kind { @SerialName("person") PERSON, @SerialName("channel") CHANNEL }
}

/**
 * «Недавние» в пустом поиске: последние 5 открытых людей или каналов. Хранится локально и не
 * секретно (только ид и имя), стирается при выходе из учётной записи.
 */
interface RecentsStore {
    val items: StateFlow<List<RecentItem>>
    fun add(item: RecentItem)
    fun clear()
}

/** Правило списка «Недавние»: новое — первым, без повторов, не больше [limit]. */
fun List<RecentItem>.withRecent(item: RecentItem, limit: Int = RECENTS_LIMIT): List<RecentItem> =
    (listOf(item) + filterNot { it.kind == item.kind && it.id == item.id }).take(limit)

const val RECENTS_LIMIT = 5

@Singleton
class SharedPreferencesRecentsStore internal constructor(
    private val prefs: SharedPreferences,
    session: SessionRepository
) : RecentsStore {

    @Inject
    constructor(@ApplicationContext context: Context, session: SessionRepository) :
        this(context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE), session)

    private val json = Json { ignoreUnknownKeys = true }
    private val serializer = ListSerializer(RecentItem.serializer())
    private val _items = MutableStateFlow(load())
    override val items: StateFlow<List<RecentItem>> = _items.asStateFlow()

    init {
        // Unconfined: стирание — сразу там, где сессия закончилась.
        CoroutineScope(SupervisorJob() + Dispatchers.Unconfined).launch {
            session.token.collect { token -> if (token == null) clear() }
        }
    }

    override fun add(item: RecentItem) {
        val next = _items.value.withRecent(item)
        _items.value = next
        prefs.edit().putString(KEY, json.encodeToString(serializer, next)).apply()
    }

    override fun clear() {
        _items.value = emptyList()
        prefs.edit().remove(KEY).apply()
    }

    private fun load(): List<RecentItem> =
        runCatching { prefs.getString(KEY, null)?.let { json.decodeFromString(serializer, it) } }.getOrNull().orEmpty()

    companion object {
        const val FILE_NAME = "centychat_search_recents"
        private const val KEY = "recents"
    }
}
