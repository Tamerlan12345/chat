import Foundation
import XCTest
@testable import CentyChat

/// The session's people directory: cache first, then the server; live presence; wiped on sign-out.
@MainActor
final class PeopleStoreTests: XCTestCase {
    private let bob = PublicUser(id: 8, username: "bob", fullName: "Боб Тестов", status: .online)
    private let carol = PublicUser(id: 9, username: "carol", fullName: "Карина Смирнова", status: .offline)
    private let me = PublicUser(id: 1, username: "me", fullName: "Тест Тестов")

    private func store(_ source: FakePeopleSource, cache: InMemoryPeopleCache = InMemoryPeopleCache(), owner: Int64? = 1) -> PeopleStore {
        PeopleStore(source: source, cache: cache, ownerId: { owner })
    }

    func testTheCachedListShowsAtOnceAndTheServerReplacesIt() async {
        let source = FakePeopleSource(users: [me, bob, carol])
        let cache = InMemoryPeopleCache()
        cache.value = CachedPeople(ownerId: 1, savedAt: Date(), people: [Person(id: 8, fullName: "Боб Старый")], tree: nil, selfPerson: nil)
        let people = store(source, cache: cache)

        people.refresh()
        XCTAssertTrue(people.state.isLoaded, "The cache is shown before the network answers")
        XCTAssertEqual(people.state.people.map(\.fullName), ["Боб Старый"])

        await people.refreshAndWait()
        XCTAssertEqual(people.state.people.map(\.id), [8, 9], "Yourself is never listed")
        XCTAssertEqual(people.state.selfPerson?.id, 1)
        XCTAssertEqual(cache.value?.people.map(\.id), [8, 9], "The fresh list is cached for the next launch")
    }

    func testAnotherUsersCacheIsIgnored() {
        let cache = InMemoryPeopleCache()
        cache.value = CachedPeople(ownerId: 99, savedAt: Date(), people: [Person(id: 8, fullName: "Чужой")], tree: nil, selfPerson: nil)
        let people = store(FakePeopleSource(users: [], gate: TestGate()), cache: cache)
        people.refresh()
        XCTAssertFalse(people.state.isLoaded)
    }

    func testAFailedRefreshKeepsTheListAndSaysSo() async {
        let source = FakePeopleSource(users: [me, bob])
        let people = store(source)
        await people.refreshAndWait()
        source.failure = APIError.noConnection

        await people.refreshAndWait()
        XCTAssertTrue(people.state.refreshFailed)
        XCTAssertEqual(people.state.people.map(\.id), [8])
    }

    func testPresenceComesLiveAndGoingOfflineStampsLastSeen() async {
        let stamp = Date(timeIntervalSince1970: 1_790_000_000)
        let people = PeopleStore(source: FakePeopleSource(users: [bob]), cache: InMemoryPeopleCache(), ownerId: { 1 }, clock: { stamp })
        await people.refreshAndWait()

        people.handle(TestModels.event(#"{"type":"user_status_changed","userId":8,"status":"offline","customStatus":null}"#))
        XCTAssertEqual(people.state.people.first?.status, .offline)
        XCTAssertEqual(people.state.people.first?.lastSeen, stamp)

        people.handle(TestModels.event(#"{"type":"user_status_changed","userId":8,"status":"dnd","customStatus":"  На встрече "}"#))
        XCTAssertEqual(people.state.people.first?.status, .dnd)
        XCTAssertEqual(people.state.people.first?.customStatus, "На встрече")
    }

    func testSignOutWipesTheListAndTheCache() async {
        let cache = InMemoryPeopleCache()
        let people = store(FakePeopleSource(users: [bob]), cache: cache)
        await people.refreshAndWait()
        XCTAssertNotNil(cache.value)

        people.signOut()
        XCTAssertEqual(people.state, PeopleState())
        XCTAssertNil(cache.value)
    }
}

/// The «Сотрудники» screen model: filters and requests from other tabs.
@MainActor
final class PeopleModelTests: XCTestCase {
    private let tree = OrgTree(tree: [
        OrgDepartment(id: 1, name: "Головной офис", subDepartments: [OrgDepartment(id: 2, name: "Бухгалтерия")]),
        OrgDepartment(id: 3, name: "Филиал"),
    ])

    private func directory() -> FakePeopleDirectory {
        FakePeopleDirectory([
            Person(id: 8, fullName: "Боб Тестов", departmentId: 2, status: .online),
            Person(id: 9, fullName: "Карина Смирнова", departmentId: 3),
            Person(id: 10, fullName: "Алексей Петров"),
        ], tree: tree, selfPerson: Person(id: 1, fullName: "Тест Тестов", departmentId: 3))
    }

    func testOpeningTheTabRefreshesAndListsLettersWithASummary() {
        let people = directory()
        let model = PeopleModel(directory: people, requests: PeopleRequests())
        XCTAssertEqual(people.refreshes, 1)
        let state = model.state
        XCTAssertEqual(state.sections.map(\.letter), ["А", "Б", "К"])
        XCTAssertEqual(state.total, 3)
        XCTAssertEqual(state.online, 1)
    }

    func testTheListIsBuiltOncePerChangeNotOnEveryRead() {
        let people = directory()
        let model = PeopleModel(directory: people, requests: PeopleRequests())
        _ = model.state
        _ = model.state
        _ = model.state
        XCTAssertEqual(model.presentations, 1, "Reading the state again must not sort and rank again")
        model.setQuery("боб")
        _ = model.state
        XCTAssertEqual(model.presentations, 2)
        people.state.people[0].status = .offline
        _ = model.state
        XCTAssertEqual(model.presentations, 3, "Presence changes rebuild it")
    }

    func testTheOnlineFilterKeepsOnlyReachablePeople() {
        let model = PeopleModel(directory: directory(), requests: PeopleRequests())
        model.toggleOnlineOnly()
        XCTAssertEqual(model.state.sections.flatMap(\.people).map(\.id), [8])
        XCTAssertEqual(model.state.total, 3, "The summary counts everyone")
    }

    func testDepartmentsIncludeYourselfAndStartWithTheTopLevelExpanded() {
        let model = PeopleModel(directory: directory(), requests: PeopleRequests())
        model.setScope(.departments)
        let state = model.state
        XCTAssertEqual(state.departments.map(\.name), ["Головной офис", "Филиал", PeopleDirectory.unassignedName])
        XCTAssertEqual(state.departments[1].people.map(\.id), [9, 1], "Yourself too, in alphabetical order")
        XCTAssertEqual(state.expanded, [1, 3, PeopleDirectory.unassignedID])
    }

    func testASearchFromTheChatsTabArrivesAsTheQuery() {
        let requests = PeopleRequests()
        requests.send(.search("боб"))
        let model = PeopleModel(directory: directory(), requests: requests, filters: PeopleFilters(scope: .departments))
        XCTAssertEqual(model.filters.query, "боб")
        XCTAssertEqual(model.filters.scope, .all)
        XCTAssertEqual(model.state.results.map(\.person.id), [8])
        XCTAssertNil(requests.pending)
    }

    func testTheDepartmentFromACardOpensThatBranch() {
        let requests = PeopleRequests()
        let model = PeopleModel(directory: directory(), requests: requests, filters: PeopleFilters(query: "кто-то", onlineOnly: true, expanded: []))
        requests.send(.department(2))
        model.applyPendingRequest()
        XCTAssertEqual(model.filters.scope, .departments)
        XCTAssertEqual(model.filters.query, "")
        XCTAssertFalse(model.filters.onlineOnly)
        XCTAssertEqual(model.state.expanded, [1, 2])
    }

    func testFiltersSurviveAsJson() {
        let filters = PeopleFilters(query: "боб", scope: .departments, onlineOnly: true, expanded: [1, 2])
        XCTAssertEqual(PeopleFilters.decoded(filters.encoded), filters)
        XCTAssertEqual(PeopleFilters.decoded("не json"), PeopleFilters())
    }

    /// `@SceneStorage` outlives sign-out: the next account must not see the previous one's query.
    func testStoredFiltersBelongToTheAccountThatSetThem() {
        let filters = PeopleFilters(query: "боб", scope: .departments, onlineOnly: true, expanded: [1, 2])
        let stored = filters.stored(for: 7)

        XCTAssertEqual(PeopleFilters.restored(from: stored, owner: 7), filters, "The same account gets its filters back")
        XCTAssertEqual(PeopleFilters.restored(from: stored, owner: 8), PeopleFilters(), "Another account starts clean")
        XCTAssertEqual(PeopleFilters.restored(from: stored, owner: nil), PeopleFilters())
        XCTAssertEqual(PeopleFilters.restored(from: filters.encoded, owner: 7), PeopleFilters(),
                       "Filters saved without an owner (older builds) are not handed to anyone")
        XCTAssertEqual(PeopleFilters.restored(from: "", owner: 7), PeopleFilters())
    }

    /// Ruling D: on sign-out the scene's stored filters are cleared, not only ignored.
    func testSignOutClearsTheStoredFilters() {
        let stored = PeopleFilters(query: "боб").stored(for: 7)

        XCTAssertEqual(PeopleFilters.retained(stored, signedInUser: 7), stored, "Kept while the same account is signed in")
        XCTAssertEqual(PeopleFilters.retained(stored, signedInUser: nil), "", "Cleared when the session ends")
        XCTAssertEqual(PeopleFilters.retained(stored, signedInUser: 8), "", "Never kept for another account")
    }
}

/// The container wires the directory and the search recents into the session lifecycle.
@MainActor
final class PeopleWiringTests: XCTestCase {
    func testPresenceReachesTheDirectoryAndSignOutWipesItWithTheRecents() async throws {
        let app = TestApp()
        app.peopleSource.listed = [PublicUser(id: 8, username: "bob", fullName: "Боб Тестов", status: .online)]
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")
        await app.container.people.refreshAndWait()
        XCTAssertEqual(app.container.people.state.people.map(\.id), [8])
        app.container.searchRecents.add(RecentItem(kind: .person, targetId: 8, title: "Боб Тестов"))

        await app.realtime.emit(TestModels.event(#"{"type":"user_status_changed","userId":8,"status":"dnd","customStatus":null}"#))
        let dnd = await eventually { app.container.people.state.people.first?.status == .dnd }
        XCTAssertTrue(dnd, "user_status_changed must reach the directory")

        await app.session.logout()
        XCTAssertEqual(app.container.people.state.people, [])
        XCTAssertNil(app.peopleCache.value)
        XCTAssertEqual(app.container.searchRecents.items, [])
    }
}
