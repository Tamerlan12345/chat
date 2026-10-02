package com.openmychat.mobile.features.search

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.repository.ChatRepository
import com.openmychat.mobile.data.repository.PeopleRepository
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.features.people.PeopleRequest
import com.openmychat.mobile.features.people.PeopleRequests
import com.openmychat.mobile.features.people.PeopleSearch
import com.openmychat.mobile.features.people.Person
import com.openmychat.mobile.features.people.PersonMatch
import com.openmychat.mobile.features.people.SearchText
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import androidx.lifecycle.SavedStateHandle
import javax.inject.Inject

/** Канал в выдаче и найденные части имени. */
data class ChannelMatch(val channel: Channel, val highlights: List<IntRange>)

/** Найденное сообщение: куда ведёт, кто написал и фрагмент с совпадением. */
data class MessageHit(
    val message: Message,
    val conversationType: ConversationType,
    /** Собеседник в личной переписке или ид канала. */
    val targetId: Long,
    /** Имя собеседника или канала — заголовок открываемого чата. */
    val conversationTitle: String,
    val senderName: String,
    val isOwn: Boolean,
    val snippet: String,
    val highlights: List<IntRange>
)

sealed interface MessageResults {
    /** Запрос короче двух символов: на сервер не ходим. */
    data object Idle : MessageResults
    data object Loading : MessageResults
    data class Found(val hits: List<MessageHit>) : MessageResults
    data class Failed(val rateLimited: Boolean) : MessageResults
}

data class UniversalSearchState(
    val query: String = "",
    val recents: List<RecentItem> = emptyList(),
    val people: List<PersonMatch> = emptyList(),
    /** Сколько всего сотрудников подходит («Все сотрудники (N)»). */
    val peopleTotal: Int = 0,
    val channels: List<ChannelMatch> = emptyList(),
    val messages: MessageResults = MessageResults.Idle
) {
    val isEmptyQuery: Boolean get() = query.isBlank()

    val nothingFound: Boolean
        get() = !isEmptyQuery && people.isEmpty() && channels.isEmpty() &&
            (messages as? MessageResults.Found)?.hits?.isEmpty() == true
}

/**
 * Общий поиск в «Чатах» (спецификация «Universal search»): люди и каналы — локально на каждое
 * нажатие, сообщения — с сервера через 300 мс после последнего нажатия и только от двух символов.
 * Новый запрос отменяет прежний (mapLatest-семантика): поздний ответ на старую строку не
 * показывается.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class UniversalSearchViewModel @Inject constructor(
    private val people: PeopleRepository,
    private val chats: ChatRepository,
    private val recents: RecentsStore,
    private val session: SessionRepository,
    private val peopleRequests: PeopleRequests,
    /** Строка поиска переживает смерть процесса. */
    private val saved: SavedStateHandle = SavedStateHandle()
) : ViewModel() {

    private val query = MutableStateFlow(saved.get<String>(KEY_QUERY).orEmpty())
    private val channels = MutableStateFlow<List<Channel>>(emptyList())
    private val messages = MutableStateFlow<MessageResults>(MessageResults.Idle)

    private val _state = MutableStateFlow(UniversalSearchState())
    val state: StateFlow<UniversalSearchState> = _state.asStateFlow()

    private var channelsLoaded = false

    /** Последняя строка (без пробелов по краям), дошедшая до поиска сообщений. */
    @Volatile private var lastSearched: String? = null

    init {
        viewModelScope.launch {
            combine(query, people.state, channels, recents.items, messages) { q, directory, list, recent, found ->
                local(q, directory.people, list, recent, found)
            }.collect { _state.value = it }
        }
        viewModelScope.launch {
            // Каждое нажатие отменяет и ожидание, и запрос в полёте: ответ на старую строку не придёт.
            query.map { it.trim() }
                .distinctUntilChanged()
                .collectLatest { q ->
                    lastSearched = q
                    if (q.length < MIN_SERVER_QUERY) {
                        messages.value = MessageResults.Idle
                        return@collectLatest
                    }
                    delay(DEBOUNCE_MILLIS)
                    searchMessages(q)
                }
        }
    }

    /** Поиск открыт: справочник и каналы подгружаются, если их ещё нет. */
    fun onOpened() {
        people.refresh()
        if (!channelsLoaded) {
            channelsLoaded = true
            viewModelScope.launch {
                runCatching { chats.channels() }.onSuccess { channels.value = it }.onFailure { channelsLoaded = false }
            }
        }
    }

    fun setQuery(value: String) {
        query.value = value
        saved[KEY_QUERY] = value
        // Сразу, не дожидаясь паузы: скелетон сообщений появляется вместе с локальной выдачей.
        val q = value.trim()
        // Пробел в конце строку поиска не меняет — прежняя выдача остаётся, без вечного скелетона.
        if (q.length < MIN_SERVER_QUERY) messages.value = MessageResults.Idle
        else if (q != lastSearched) messages.value = MessageResults.Loading
    }

    fun clear() = setQuery("")

    /** «Все сотрудники (N)»: вкладка «Сотрудники» откроется с этим же запросом. */
    fun showAllPeople(query: String) = peopleRequests.send(PeopleRequest.Search(query.trim()))

    fun remember(item: RecentItem) = recents.add(item)

    fun rememberPerson(person: Person) =
        recents.add(RecentItem(RecentItem.Kind.PERSON, person.id, person.fullName, person.avatarUrl))

    fun rememberChannel(channel: Channel) = recents.add(RecentItem(RecentItem.Kind.CHANNEL, channel.id, channel.name))

    private suspend fun searchMessages(q: String) {
        if (q.length < MIN_SERVER_QUERY) {
            messages.value = MessageResults.Idle
            return
        }
        messages.value = MessageResults.Loading
        val result = try {
            val found = chats.searchMessages(q)
            MessageResults.Found(found.take(MAX_MESSAGES).map { hit(it, q) })
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            MessageResults.Failed(rateLimited = e.statusCode == 429)
        } catch (_: Exception) {
            MessageResults.Failed(rateLimited = false)
        }
        // Вторая страховка от устаревшего ответа: строка поиска уже другая — не показываем.
        if (query.value.trim() == q) messages.value = result
    }

    private fun local(
        q: String,
        directory: List<Person>,
        channelList: List<Channel>,
        recent: List<RecentItem>,
        found: MessageResults
    ): UniversalSearchState {
        if (q.isBlank()) return UniversalSearchState(query = q, recents = recent)
        val ranked = PeopleSearch.rank(directory, q)
        return UniversalSearchState(
            query = q,
            recents = recent,
            people = ranked.take(MAX_PEOPLE),
            peopleTotal = ranked.size,
            channels = matchChannels(channelList, q).take(MAX_CHANNELS),
            messages = found
        )
    }

    private fun matchChannels(list: List<Channel>, q: String): List<ChannelMatch> {
        val tokens = SearchText.tokens(q.removePrefix("#"))
        if (tokens.isEmpty()) return emptyList()
        return list.mapNotNull { channel ->
            val name = SearchText.normalize(channel.name)
            val ranges = tokens.map { token -> name.indexOf(token).takeIf { it >= 0 }?.let { it until it + token.length } ?: return@mapNotNull null }
            ChannelMatch(channel, ranges.sortedBy { it.first })
        }.sortedWith(compareBy<ChannelMatch> { if (it.highlights.firstOrNull()?.first == 0) 0 else 1 }.thenBy { it.channel.name })
    }

    private fun hit(message: Message, q: String): MessageHit {
        val me = session.currentUserId
        val isOwn = message.senderId == me
        val type = message.conversationType
        val directory = people.state.value.people
        val targetId = if (type == ConversationType.CHANNEL) message.targetId else if (isOwn) message.targetId else message.senderId
        val title = if (type == ConversationType.CHANNEL) {
            message.channelName ?: channels.value.firstOrNull { it.id == message.targetId }?.name ?: ""
        } else {
            directory.firstOrNull { it.id == targetId }?.fullName ?: if (!isOwn) message.senderName else ""
        }
        val (snippet, highlights) = Snippet.of(message.text, q)
        return MessageHit(
            message = message,
            conversationType = type,
            targetId = targetId,
            conversationTitle = title,
            senderName = message.senderName.ifBlank { directory.firstOrNull { it.id == message.senderId }?.fullName.orEmpty() },
            isOwn = isOwn,
            snippet = snippet,
            highlights = highlights
        )
    }

    companion object {
        private const val KEY_QUERY = "search.query"
        const val DEBOUNCE_MILLIS = 300L
        const val MIN_SERVER_QUERY = 2
        const val MAX_PEOPLE = 5
        const val MAX_CHANNELS = 4
        const val MAX_MESSAGES = 20
    }
}

/**
 * Фрагмент сообщения для двух строк выдачи: начинается чуть раньше первого совпадения (с «…»),
 * чтобы найденное было видно, и подсветка каждого слова запроса.
 */
object Snippet {
    private const val LEAD = 32

    fun of(text: String, query: String): Pair<String, List<IntRange>> {
        val flat = text.replace(Regex("\\s+"), " ").trim()
        val tokens = SearchText.tokens(query)
        val normalized = SearchText.normalize(flat)
        val first = tokens.mapNotNull { t -> normalized.indexOf(t).takeIf { it >= 0 } }.minOrNull() ?: 0
        val start = if (first > LEAD) {
            val space = flat.lastIndexOf(' ', first - LEAD / 2).takeIf { it in (first - LEAD)..first }
            (space?.plus(1)) ?: (first - LEAD / 2)
        } else 0
        val prefix = if (start > 0) "…" else ""
        val snippet = prefix + flat.substring(start)
        val norm = SearchText.normalize(snippet)
        val ranges = ArrayList<IntRange>()
        for (t in tokens) {
            var at = norm.indexOf(t)
            while (at >= 0) {
                ranges += at until at + t.length
                at = norm.indexOf(t, at + t.length)
            }
        }
        return snippet to ranges.sortedBy { it.first }
    }
}
