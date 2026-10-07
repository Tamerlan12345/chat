import Foundation
import XCTest
@testable import CentyChat

/// Server message search for the tests: every query waits for its own gate, so the order of
/// answers is under the test's control.
actor MessageSearchServer {
    private(set) var queries: [String] = []
    private var gates: [String: TestGate] = [:]
    private var answers: [String: [Message]] = [:]
    private var failure: (any Error)?

    func failWith(_ error: any Error) {
        failure = error
    }

    /// Lets the request for `query` return `messages`.
    func answer(_ query: String, with messages: [Message]) async {
        answers[query] = messages
        await gate(for: query).open()
    }

    func search(_ query: String) async throws -> [Message] {
        queries.append(query)
        if let failure { throw failure }
        await gate(for: query).wait()
        return answers[query] ?? []
    }

    private func gate(for query: String) -> TestGate {
        if let gate = gates[query] { return gate }
        let gate = TestGate()
        gates[query] = gate
        return gate
    }
}

@MainActor
final class UniversalSearchModelTests: XCTestCase {
    private let me: Int64 = 1
    private var directory: FakePeopleDirectory!
    private var server: MessageSearchServer!
    private var recents: SearchRecentsStore!
    private var requests: PeopleRequests!
    private var channels: [Channel] = []

    override func setUp() async throws {
        let people = (1...8).map { Person(id: 10 + Int64($0), fullName: "Иванов \($0)") }
            + [Person(id: 30, fullName: "Петров Иван", status: .online)]
        directory = FakePeopleDirectory(people)
        server = MessageSearchServer()
        recents = SearchRecentsStore(defaults: nil)
        requests = PeopleRequests()
        channels = [Channel(id: 5, name: "Общий"), Channel(id: 6, name: "Иван-чай"), Channel(id: 7, name: "Склад")]
    }

    private func makeModel(debounce: Duration = .milliseconds(300)) -> UniversalSearchModel {
        let server = self.server!
        return UniversalSearchModel(
            directory: directory,
            channels: { [unowned self] in self.channels },
            searchMessages: { query in try await server.search(query) },
            recents: recents,
            requests: requests,
            currentUserId: { [me] in me },
            debounce: debounce
        )
    }

    private func message(
        _ id: Int64,
        _ text: String,
        from: Int64,
        to: Int64,
        type: ConversationType = .direct
    ) -> Message {
        Message(id: id, conversationType: type, targetId: to, senderId: from, text: text, senderName: "Отправитель \(from)")
    }

    private func wait(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    func testPeopleAndChannelsAppearOnEveryKeystrokeWithoutTheServer() async {
        let model = makeModel()
        model.setQuery("иван")

        let state = model.state
        XCTAssertEqual(state.people.count, 5, "At most five people")
        XCTAssertEqual(state.people.first?.person.id, 30, "Online first within the rank")
        XCTAssertEqual(state.peopleTotal, 9, "«Все сотрудники (N)»")
        XCTAssertEqual(state.channels.map(\.channel.name), ["Иван-чай"])
        XCTAssertEqual(state.channels.first?.highlights, [0..<4])
        XCTAssertEqual(state.messages, .loading)
        let asked = await server.queries
        XCTAssertEqual(asked, [], "The server is not asked before the pause")
    }

    func testChannelsMatchWithoutTheHashAndAtMostFour() {
        channels = (1...6).map { Channel(id: Int64($0), name: "#проект-\($0)") }
        let model = makeModel()
        model.setQuery("#проект")
        XCTAssertEqual(model.state.channels.count, 4)
    }

    func testMessagesAreAskedOnceAfterThePauseFollowingTheLastKeystroke() async {
        let model = makeModel(debounce: .milliseconds(200))
        model.setQuery("о")
        model.setQuery("от")
        await wait(0.05)
        model.setQuery("отч")
        await wait(0.1)
        var asked = await server.queries
        XCTAssertEqual(asked, [], "Still inside the pause")
        await wait(0.3)
        asked = await server.queries
        XCTAssertEqual(asked, ["отч"])
    }

    func testAShortQueryNeverReachesTheServer() async {
        let model = makeModel(debounce: .milliseconds(20))
        model.setQuery("о")
        await wait(0.15)
        let asked = await server.queries
        XCTAssertEqual(asked, [])
        XCTAssertEqual(model.state.messages, .idle)
    }

    func testALateAnswerForAnOldQueryIsDropped() async {
        let model = makeModel(debounce: .milliseconds(20))
        model.setQuery("отч")
        let first = await eventually { await self.server.queries == ["отч"] }
        XCTAssertTrue(first)

        model.setQuery("отчёт")
        await server.answer("отч", with: [message(1, "отчёт старый", from: 30, to: me)])
        await wait(0.05)
        XCTAssertEqual(model.state.messages, .loading, "The answer for «отч» came after the query changed")

        let second = await eventually { await self.server.queries == ["отч", "отчёт"] }
        XCTAssertTrue(second)
        await server.answer("отчёт", with: [message(2, "Квартальный отчёт", from: 30, to: me)])
        let found = await eventually { model.state.messages.hits?.map(\.message.id) == [2] }
        XCTAssertTrue(found, "\(model.state.messages)")
    }

    func testHitsKnowWhereTheyLeadAndWhatToHighlight() async throws {
        let model = makeModel(debounce: .milliseconds(10))
        model.setQuery("отчёт")
        _ = await eventually { await self.server.queries == ["отчёт"] }
        await server.answer("отчёт", with: [
            message(2, "Готов отчёт", from: 30, to: me),
            message(3, "Мой ОТЧЕТ", from: me, to: 11),
            message(4, "отчёт в канал", from: 12, to: 5, type: .channel),
        ])
        _ = await eventually { model.state.messages.hits != nil }
        let hits = try XCTUnwrap(model.state.messages.hits)
        XCTAssertEqual(hits.map(\.targetId), [30, 11, 5])
        XCTAssertEqual(hits.map(\.conversationTitle), ["Петров Иван", "Иванов 1", "Общий"])
        XCTAssertEqual(hits.map(\.isOwn), [false, true, false])
        XCTAssertEqual(hits[0].highlights, [6..<11])
        XCTAssertEqual(hits[1].highlights, [4..<9], "«ё» = «е»")
        XCTAssertEqual(hits.map(\.route.highlightMessageId), [2, 3, 4])
        XCTAssertEqual(hits[2].route.type, .channel)
    }

    func testAHitShowsItsAuthorsPhotoAndOwnDialogHitsShowYours() async throws {
        directory.state.selfPerson = Person(id: me, fullName: "Тест Тестов", avatarUrl: "/api/users/1/avatar?v=3")
        directory.state.people[8].avatarUrl = "/api/users/30/avatar?v=1"
        let model = makeModel(debounce: .milliseconds(10))
        model.setQuery("отчёт")
        _ = await eventually { await self.server.queries == ["отчёт"] }
        await server.answer("отчёт", with: [
            message(2, "Готов отчёт", from: 30, to: me),
            message(3, "Мой отчёт", from: me, to: 11),
        ])
        _ = await eventually { model.state.messages.hits != nil }
        let hits = try XCTUnwrap(model.state.messages.hits)
        XCTAssertEqual(hits.map(\.avatarName), ["Петров Иван", "Тест Тестов"], "«Вы» goes with your own avatar")
        XCTAssertEqual(hits.map(\.avatarUrl), ["/api/users/30/avatar?v=1", "/api/users/1/avatar?v=3"])
    }

    func testTheDirectoryIsRankedOncePerQueryNotOnEveryRead() {
        let model = makeModel()
        model.setQuery("иван")
        _ = model.state
        _ = model.state
        _ = model.firstResult
        XCTAssertEqual(model.rankings, 1, "Reading the state again must not re-rank the directory")
        model.setQuery("иванов")
        _ = model.state
        XCTAssertEqual(model.rankings, 2)
        directory.state.people.append(Person(id: 99, fullName: "Иванова Новая"))
        _ = model.state
        XCTAssertEqual(model.rankings, 3, "A changed directory is ranked again")
    }

    func testATrailingSpaceNeitherSearchesAgainNorLeavesTheSkeleton() async {
        let model = makeModel(debounce: .milliseconds(10))
        model.setQuery("план")
        _ = await eventually { await self.server.queries == ["план"] }
        await server.answer("план", with: [message(5, "план готов", from: 30, to: me)])
        _ = await eventually { model.state.messages.hits != nil }

        model.setQuery("план ")
        await wait(0.1)
        XCTAssertNotNil(model.state.messages.hits, "A trailing space keeps the same results")
        model.setQuery("план")
        await wait(0.1)
        XCTAssertNotNil(model.state.messages.hits)
        let asked = await server.queries
        XCTAssertEqual(asked, ["план"])
    }

    func testRateLimitIsReportedApart() async {
        await server.failWith(APIError.httpError(statusCode: 429, message: "Слишком много", code: nil, retryAfter: 60))
        let model = makeModel(debounce: .milliseconds(10))
        model.setQuery("план")
        let failed = await eventually { model.state.messages == .failed(rateLimited: true) }
        XCTAssertTrue(failed, "\(model.state.messages)")
    }

    func testAnEmptyQueryShowsRecentsNewestFirst() {
        let model = makeModel()
        model.rememberPerson(Person(id: 30, fullName: "Петров Иван"))
        model.rememberChannel(Channel(id: 5, name: "Общий"))
        XCTAssertTrue(model.state.isEmptyQuery)
        XCTAssertEqual(model.state.recents.map(\.title), ["Общий", "Петров Иван"])
    }

    func testNothingFoundOnlyOnceTheServerAnsweredToo() async {
        let model = makeModel(debounce: .milliseconds(10))
        model.setQuery("щщщ")
        XCTAssertFalse(model.state.nothingFound, "Messages are still loading")
        _ = await eventually { await self.server.queries == ["щщщ"] }
        await server.answer("щщщ", with: [])
        let none = await eventually { model.state.nothingFound }
        XCTAssertTrue(none)
    }

    func testAllPeopleCarriesTheQueryToThePeopleTab() {
        let model = makeModel()
        model.setQuery(" иван ")
        model.showAllPeople()
        XCTAssertEqual(requests.pending, .search("иван"))
    }

    func testReturnOpensTheFirstResultInSectionOrder() {
        let model = makeModel()
        model.setQuery("иван")
        XCTAssertEqual(model.firstResult, .person(30))
        model.setQuery("склад")
        XCTAssertEqual(model.firstResult, .channel(7))
        model.setQuery("")
        XCTAssertNil(model.firstResult)
    }

    func testOpeningTheSearchRefreshesTheDirectory() {
        let model = makeModel()
        model.opened()
        XCTAssertEqual(directory.refreshes, 1)
    }

    // MARK: - Snippet

    func testLongMessagesAreCutBeforeTheMatch() {
        let text = "Коллеги, напоминаю, что в пятницу мы сдаём все документы, а также квартальный отчёт по складу"
        let (snippet, ranges) = Snippet.of(text, query: "отчёт")
        XCTAssertTrue(snippet.hasPrefix("…"), snippet)
        XCTAssertEqual(ranges.count, 1)
        let characters = Array(snippet)
        XCTAssertEqual(String(characters[ranges[0]]), "отчёт")
    }

    func testShortMessagesKeepTheirStartAndEveryWordIsHighlighted() {
        let (snippet, ranges) = Snippet.of("План  на\nзавтра: план", query: "план")
        XCTAssertEqual(snippet, "План на завтра: план")
        XCTAssertEqual(ranges, [0..<4, 16..<20])
    }
}

@MainActor
final class SearchRecentsTests: XCTestCase {
    private func item(_ kind: RecentItem.Kind, _ id: Int64, _ title: String = "") -> RecentItem {
        RecentItem(kind: kind, targetId: id, title: title.isEmpty ? "\(kind) \(id)" : title)
    }

    func testTheNewestComesFirstWithoutDuplicatesAndAtMostFive() {
        let store = SearchRecentsStore(defaults: nil)
        for id in 1...6 {
            store.add(item(.person, Int64(id)))
        }
        store.add(item(.person, 3))
        store.add(item(.channel, 3))
        XCTAssertEqual(store.items.map(\.id), ["channel-3", "person-3", "person-6", "person-5", "person-4"])
    }

    func testRecentsSurviveARestartAndAreWipedOnSignOut() throws {
        let suite = "centychat.tests.recents.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let first = SearchRecentsStore(defaults: defaults)
        first.add(RecentItem(kind: .person, targetId: 8, title: "Боб Тестов", avatarUrl: nil))
        let restored = SearchRecentsStore(defaults: defaults)
        XCTAssertEqual(restored.items.map(\.title), ["Боб Тестов"])

        restored.clear()
        XCTAssertEqual(SearchRecentsStore(defaults: defaults).items, [])
    }
}

final class HighlightTests: XCTestCase {
    func testRunsSplitTheTextAtCharacterOffsets() {
        XCTAssertEqual(
            Highlight.runs("Петров Иван", [7..<11]).map { "\($0.highlighted ? "+" : "-")\($0.text)" },
            ["-Петров ", "+Иван"]
        )
    }

    func testOverlappingOrOutOfBoundsRangesAreClamped() {
        XCTAssertEqual(
            Highlight.runs("Ёлка", [0..<2, 1..<3, 3..<10]).map { "\($0.highlighted ? "+" : "-")\($0.text)" },
            ["+Ёлка"]
        )
        XCTAssertEqual(Highlight.runs("abc", []).map(\.text), ["abc"])
    }
}
