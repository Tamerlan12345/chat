package com.openmychat.mobile.features.search

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.repository.PeopleRepository
import com.openmychat.mobile.data.repository.PeopleState
import com.openmychat.mobile.features.people.Person
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class UniversalSearchViewModelTest {

    @get:Rule val mainDispatcher = MainDispatcherRule(StandardTestDispatcher())

    private class FakePeople(people: List<Person>) : PeopleRepository {
        override val state = MutableStateFlow(PeopleState(people = people, isLoaded = true))
        override fun refresh() = Unit
        override suspend fun person(id: Long): Person? = null
    }

    private class MemoryRecents : RecentsStore {
        override val items = MutableStateFlow<List<RecentItem>>(emptyList())
        override fun add(item: RecentItem) {
            items.value = items.value.withRecent(item)
        }
        override fun clear() {
            items.value = emptyList()
        }
    }

    /** Поиск по сообщениям: каждый запрос ждёт своей «отмашки», чтобы проверить порядок ответов. */
    private class SearchServer : FakeChatRepository() {
        val queries = mutableListOf<String>()
        val gates = mutableMapOf<String, CompletableDeferred<List<Message>>>()
        var failure: Exception? = null
        override suspend fun searchMessages(query: String): List<Message> {
            queries += query
            failure?.let { throw it }
            return gates.getOrPut(query) { CompletableDeferred() }.await()
        }
    }

    private val directory = (1..8).map { Person(id = 10L + it, fullName = "Иванов $it") } +
        Person(id = 30, fullName = "Петров Иван", status = UserStatus.ONLINE)
    private val server = SearchServer().apply {
        channels = listOf(Channel(id = 5, name = "Общий"), Channel(id = 6, name = "Иван-чай"), Channel(id = 7, name = "Склад"))
    }
    private val recents = MemoryRecents()
    private val requests = com.openmychat.mobile.features.people.PeopleRequests()

    private fun viewModel() = UniversalSearchViewModel(FakePeople(directory), server, recents, FakeSessionRepository(), requests)

    private fun message(id: Long, text: String, from: Long, to: Long, type: ConversationType = ConversationType.DIRECT, channelName: String? = null) =
        Message(id = id, conversationType = type, targetId = to, senderId = from, text = text, senderName = "Отправитель $from", createdAt = "2026-10-02T09:00:00.000Z", channelName = channelName)

    @Test
    fun peopleAndChannelsAppearOnEveryKeystrokeWithoutTheServer() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()
        vm.onOpened()
        runCurrent()
        vm.setQuery("иван")
        runCurrent()

        val state = vm.state.value
        assertEquals("максимум пять людей", 5, state.people.size)
        assertEquals("в сети — первым в своём ранге", 30L, state.people.first().person.id)
        assertEquals("«Все сотрудники (N)»", 9, state.peopleTotal)
        assertEquals(listOf("Иван-чай"), state.channels.map { it.channel.name })
        assertEquals(MessageResults.Loading, state.messages)
        assertEquals("сервер ещё не спрошен", emptyList<String>(), server.queries)
    }

    @Test
    fun messagesAreAskedOnce300msAfterTheLastKeystroke() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()
        runCurrent()
        vm.setQuery("о")
        runCurrent()
        vm.setQuery("от")
        advanceTimeBy(200)
        vm.setQuery("отч")
        advanceTimeBy(299)
        runCurrent()
        assertEquals(emptyList<String>(), server.queries)
        advanceTimeBy(2)
        runCurrent()
        assertEquals(listOf("отч"), server.queries)
    }

    @Test
    fun aShortQueryNeverReachesTheServer() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()
        vm.setQuery("о")
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(emptyList<String>(), server.queries)
        assertEquals(MessageResults.Idle, vm.state.value.messages)
    }

    @Test
    fun aLateAnswerForAnOldQueryIsDropped() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()
        runCurrent()
        vm.setQuery("отч")
        advanceTimeBy(301)
        runCurrent()
        assertEquals(listOf("отч"), server.queries)

        vm.setQuery("отчёт")
        runCurrent()
        // Ответ на «отч» пришёл, когда строка уже другая: не показываем.
        server.gates.getValue("отч").complete(listOf(message(1, "отчёт старый", from = 30, to = ME)))
        runCurrent()
        assertEquals(MessageResults.Loading, vm.state.value.messages)

        advanceTimeBy(301)
        runCurrent()
        server.gates.getValue("отчёт").complete(listOf(message(2, "Квартальный отчёт", from = 30, to = ME)))
        runCurrent()
        val found = vm.state.value.messages as MessageResults.Found
        assertEquals(listOf(2L), found.hits.map { it.message.id })
    }

    @Test
    fun hitsKnowWhereTheyLeadAndWhatToHighlight() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()
        vm.onOpened()
        runCurrent()
        vm.setQuery("отчёт")
        advanceTimeBy(301)
        runCurrent()
        server.gates.getValue("отчёт").complete(
            listOf(
                message(2, "Готов отчёт", from = 30, to = ME),
                message(3, "Мой ОТЧЕТ", from = ME, to = 11),
                message(4, "отчёт в канал", from = 12, to = 5, type = ConversationType.CHANNEL, channelName = "Общий")
            )
        )
        runCurrent()
        val hits = (vm.state.value.messages as MessageResults.Found).hits
        assertEquals(listOf(30L, 11L, 5L), hits.map { it.targetId })
        assertEquals(listOf("Петров Иван", "Иванов 1", "Общий"), hits.map { it.conversationTitle })
        assertEquals(listOf(false, true, false), hits.map { it.isOwn })
        assertEquals(listOf(6 until 11), hits[0].highlights)
        assertEquals("«ё» = «е»", listOf(4 until 9), hits[1].highlights)
    }

    @Test
    fun rateLimitIsReportedApart() = runTest(mainDispatcher.dispatcher) {
        server.failure = ApiException(429, null, "Слишком много")
        val vm = viewModel()
        runCurrent()
        vm.setQuery("план")
        advanceTimeBy(301)
        runCurrent()
        assertEquals(MessageResults.Failed(rateLimited = true), vm.state.value.messages)
    }

    @Test
    fun anEmptyQueryShowsRecents() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()
        vm.rememberPerson(directory.last())
        vm.rememberChannel(Channel(id = 5, name = "Общий"))
        runCurrent()
        assertTrue(vm.state.value.isEmptyQuery)
        assertEquals(listOf("Общий", "Петров Иван"), vm.state.value.recents.map { it.title })
    }

    @Test
    fun allPeopleCarriesTheQueryToThePeopleTab() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()
        vm.showAllPeople(" иван ")
        assertEquals(com.openmychat.mobile.features.people.PeopleRequest.Search("иван"), requests.pending.value)
    }

    @Test
    fun longMessagesAreCutBeforeTheMatch() {
        val text = "Коллеги, напоминаю, что в пятницу мы сдаём все документы, а также квартальный отчёт по складу"
        val (snippet, ranges) = Snippet.of(text, "отчёт")
        assertTrue(snippet, snippet.startsWith("…"))
        assertEquals("отчёт", snippet.substring(ranges.single()))
    }
}
