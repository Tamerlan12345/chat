package com.openmychat.mobile.data.repository

import android.content.Context
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.OrgTree
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.di.ApplicationScope
import com.openmychat.mobile.features.people.PeopleDirectory
import com.openmychat.mobile.features.people.Person
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

/** Справочник для экрана «Сотрудники», поиска и карточки. */
data class PeopleState(
    val people: List<Person> = emptyList(),
    val tree: OrgTree? = null,
    /** Есть что показать (из кэша или с сервера). */
    val isLoaded: Boolean = false,
    val isRefreshing: Boolean = false,
    /** Последнее обновление не удалось; список на экране — прежний. */
    val refreshFailed: Boolean = false
)

interface PeopleRepository {
    val state: StateFlow<PeopleState>

    /** Показать кэш (если ещё не показан) и обновить с сервера; повторный вызов во время загрузки — тот же запрос. */
    fun refresh()

    /** Свежая карточка сотрудника с сервера; обновляет его и в справочнике. */
    suspend fun person(id: Long): Person?
}

/** Откуда берётся справочник: в приложении — API, в тестах — подделка. */
interface PeopleSource {
    suspend fun users(): List<User>
    suspend fun orgTree(): OrgTree
    suspend fun user(id: Long): User
}

class ApiPeopleSource @Inject constructor(private val api: ApiClient) : PeopleSource {
    override suspend fun users(): List<User> = api.getUsers()
    override suspend fun orgTree(): OrgTree = api.getOrgTree()
    override suspend fun user(id: Long): User = api.getUser(id)
}

/** Последний справочник на диске, чтобы вкладка открывалась сразу и без сети. */
@Serializable
data class CachedPeople(
    @SerialName("owner_id") val ownerId: Long,
    @SerialName("saved_at") val savedAt: Long,
    @SerialName("people") val people: List<Person>,
    @SerialName("tree") val tree: OrgTree? = null
)

interface PeopleCache {
    suspend fun read(): CachedPeople?
    suspend fun write(value: CachedPeople)
    suspend fun clear()
}

/**
 * Файл в `noBackupFilesDir`: в резервные копии не попадает. Не секрет (тот же справочник видит
 * любой вошедший сотрудник), но после выхода из учётной записи стирается.
 */
class FilePeopleCache @Inject constructor(@ApplicationContext context: Context) : PeopleCache {
    private val file = File(context.noBackupFilesDir, FILE_NAME)
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    override suspend fun read(): CachedPeople? = withContext(Dispatchers.IO) {
        runCatching { if (file.exists()) json.decodeFromString<CachedPeople>(file.readText()) else null }.getOrNull()
    }

    override suspend fun write(value: CachedPeople) = withContext(Dispatchers.IO) {
        runCatching {
            val tmp = File(file.parentFile, "$FILE_NAME.tmp")
            tmp.writeText(json.encodeToString(CachedPeople.serializer(), value))
            if (!tmp.renameTo(file)) {
                file.delete()
                tmp.renameTo(file)
            }
        }
        Unit
    }

    override suspend fun clear() = withContext(Dispatchers.IO) {
        file.delete()
        Unit
    }

    private companion object {
        const val FILE_NAME = "people-directory.json"
    }
}

@Singleton
class DefaultPeopleRepository(
    private val source: PeopleSource,
    private val cache: PeopleCache,
    private val realtime: RealtimeRepository,
    private val session: SessionRepository,
    private val scope: CoroutineScope,
    private val clock: () -> Long
) : PeopleRepository {

    @Inject
    constructor(
        source: ApiPeopleSource,
        cache: FilePeopleCache,
        realtime: RealtimeRepository,
        session: SessionRepository,
        @ApplicationScope scope: CoroutineScope
    ) : this(source, cache, realtime, session, scope, System::currentTimeMillis)

    private val _state = MutableStateFlow(PeopleState())
    override val state: StateFlow<PeopleState> = _state.asStateFlow()

    private var refreshJob: Job? = null
    private var cacheShown = false

    init {
        scope.launch { realtime.events.collect { if (it is WsEvent.UserStatusChanged) onPresence(it) } }
        scope.launch {
            session.token.collect { token ->
                if (token == null) signOut()
            }
        }
    }

    override fun refresh() {
        if (refreshJob?.isActive == true) return
        _state.update { it.copy(isRefreshing = true) }
        refreshJob = scope.launch {
            val owner = session.currentUserId
            if (!cacheShown) {
                cacheShown = true
                val cached = cache.read()?.takeIf { owner != null && it.ownerId == owner }
                if (cached != null && !_state.value.isLoaded) {
                    _state.update { it.copy(people = cached.people, tree = cached.tree, isLoaded = true) }
                }
            }
            try {
                val tree = async { runCatching { source.orgTree() }.getOrNull() }
                val users = source.users()
                val freshTree = tree.await() ?: _state.value.tree
                val people = PeopleDirectory.people(users, freshTree, owner)
                _state.value = PeopleState(people = people, tree = freshTree, isLoaded = true)
                if (owner != null && session.token.value != null) {
                    cache.write(CachedPeople(ownerId = owner, savedAt = clock(), people = people, tree = freshTree))
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                _state.update { it.copy(isRefreshing = false, refreshFailed = true) }
            }
        }
    }

    override suspend fun person(id: Long): Person? {
        val user = runCatching { source.user(id) }.getOrNull() ?: return _state.value.people.firstOrNull { it.id == id }
        val known = _state.value.people.firstOrNull { it.id == id }
        val names = _state.value.tree?.let { tree -> PeopleDirectory.people(listOf(user), tree, null).firstOrNull()?.departmentName }
        val fresh = Person.from(user, departmentName = names ?: user.departmentName ?: known?.departmentName)
        _state.update { state ->
            state.copy(people = state.people.map { if (it.id == id) fresh else it })
        }
        return fresh
    }

    private fun onPresence(event: WsEvent.UserStatusChanged) {
        _state.update { state ->
            if (state.people.none { it.id == event.userId }) return@update state
            state.copy(people = state.people.map { person ->
                if (person.id != event.userId) return@map person
                person.copy(
                    status = event.status,
                    customStatus = event.customStatus ?: person.customStatus,
                    // Ушёл из сети только что: «был(а) в сети сегодня в …» — по этому событию.
                    lastSeen = if (event.status == UserStatus.OFFLINE && person.status != UserStatus.OFFLINE) {
                        Instant.ofEpochMilli(clock()).toString()
                    } else person.lastSeen
                )
            })
        }
    }

    private fun signOut() {
        refreshJob?.cancel()
        refreshJob = null
        cacheShown = false
        _state.value = PeopleState()
        scope.launch { cache.clear() }
    }
}
