import Foundation
import Observation

/// Справочник, на который смотрят экраны: настоящий `PeopleStore` или подделка в тестах и превью.
@MainActor
public protocol PeopleProviding: AnyObject {
    var state: PeopleState { get }
    /// Показать кэш и обновить с сервера.
    func refresh()
    /// То же и дождаться ответа сервера («потянуть, чтобы обновить»).
    func refreshAndWait() async
    /// Свежая карточка сотрудника с сервера; обновляет его и в справочнике.
    func person(id: Int64) async -> Person?
}

extension PeopleStore: PeopleProviding {}

public enum PeopleScope: String, Codable, Sendable, CaseIterable {
    case all
    case departments
}

/// Что попросили показать на «Сотрудниках» из другого места: запрос из поиска «Чатов» или
/// отдел из карточки.
public enum PeopleRequest: Equatable, Sendable {
    case search(String)
    case department(Int64)
}

/// Передача `PeopleRequest` во вкладку «Сотрудники» (и переключение на неё).
@Observable
@MainActor
public final class PeopleRequests {
    public private(set) var pending: PeopleRequest?
    /// Растёт с каждой просьбой: оболочка переключает вкладку и по повтору той же просьбы.
    public private(set) var serial = 0

    public init() {}

    public func send(_ request: PeopleRequest) {
        pending = request
        serial += 1
    }

    public func consume() -> PeopleRequest? {
        defer { pending = nil }
        return pending
    }
}

/// Фильтры «Сотрудников»; переживают смерть процесса (`@SceneStorage` хранит их JSON).
public struct PeopleFilters: Codable, Equatable, Sendable {
    public var query = ""
    public var scope = PeopleScope.all
    public var onlineOnly = false
    /// nil — как на настольном клиенте: верхний уровень раскрыт, пока сотрудник ничего не трогал.
    public var expanded: Set<Int64>?

    public init(query: String = "", scope: PeopleScope = .all, onlineOnly: Bool = false, expanded: Set<Int64>? = nil) {
        self.query = query
        self.scope = scope
        self.onlineOnly = onlineOnly
        self.expanded = expanded
    }

    public var encoded: String {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    public static func decoded(_ text: String) -> PeopleFilters {
        guard let data = text.data(using: .utf8), let filters = try? JSONDecoder().decode(PeopleFilters.self, from: data) else {
            return PeopleFilters()
        }
        return filters
    }

    /// `@SceneStorage` outlives sign-out, so the filters are saved with the account that set
    /// them and handed back only to that account: the next one starts with an empty query.
    func stored(for owner: Int64?) -> String {
        guard let owner else { return "" }
        let envelope = OwnedPeopleFilters(owner: owner, filters: self)
        return (try? JSONEncoder().encode(envelope)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    static func retained(_ stored: String, signedInUser: Int64?) -> String { stored }

    static func restored(from text: String, owner: Int64?) -> PeopleFilters {
        guard let owner, let data = text.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(OwnedPeopleFilters.self, from: data),
              envelope.owner == owner else {
            return PeopleFilters()
        }
        return envelope.filters
    }
}

/// What `PeopleView` keeps in `@SceneStorage`: the filters and whose they are.
private struct OwnedPeopleFilters: Codable {
    let owner: Int64
    let filters: PeopleFilters
}

public struct PeopleUIState: Equatable, Sendable {
    public var isLoaded = false
    public var isRefreshing = false
    public var refreshFailed = false
    public var total = 0
    public var online = 0
    public var query = ""
    public var scope = PeopleScope.all
    public var onlineOnly = false
    /// «Все» без запроса: разделы А–Я.
    public var sections: [LetterSection] = []
    /// «Все» с запросом: ранжированная выдача.
    public var results: [PersonMatch] = []
    /// «Отделы»: отфильтрованное дерево.
    public var departments: [DepartmentNode] = []
    public var expanded: Set<Int64> = []

    public var isSearching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Нечего показать при включённом фильтре или запросе.
    public var isEmptyResult: Bool {
        guard isLoaded else { return false }
        switch scope {
        case .all: return isSearching ? results.isEmpty : sections.isEmpty
        case .departments: return departments.isEmpty
        }
    }
}

/// Экран «Сотрудники». Порт `PeopleViewModel` (Android).
@Observable
@MainActor
public final class PeopleModel {
    public private(set) var filters: PeopleFilters

    @ObservationIgnored private let directory: any PeopleProviding
    @ObservationIgnored private let requests: PeopleRequests

    public init(directory: any PeopleProviding, requests: PeopleRequests, filters: PeopleFilters = PeopleFilters()) {
        self.directory = directory
        self.requests = requests
        self.filters = filters
        directory.refresh()
        applyPendingRequest()
    }

    public var state: PeopleUIState {
        Self.present(directory.state, filters)
    }

    public func setQuery(_ query: String) {
        filters.query = query
    }

    public func setScope(_ scope: PeopleScope) {
        filters.scope = scope
    }

    public func toggleOnlineOnly() {
        filters.onlineOnly.toggle()
    }

    public func toggleDepartment(_ id: Int64) {
        var current = filters.expanded ?? defaultExpanded()
        if current.contains(id) {
            current.remove(id)
        } else {
            current.insert(id)
        }
        filters.expanded = current
    }

    public func refresh() {
        directory.refresh()
    }

    /// Pull to refresh: waits for the server.
    public func refreshAndWait() async {
        await directory.refreshAndWait()
    }

    /// Просьба из поиска «Чатов» или из карточки, если она есть.
    public func applyPendingRequest() {
        guard let request = requests.consume() else { return }
        switch request {
        case .search(let query):
            filters.query = query
            filters.scope = .all
        case .department(let id):
            let data = directory.state
            let nodes = PeopleDirectory.departments(tree: data.tree, people: data.people)
            let path = PeopleDirectory.path(to: id, in: nodes)
            filters.query = ""
            filters.scope = .departments
            filters.onlineOnly = false
            filters.expanded = (filters.expanded ?? defaultExpanded()).union(path)
        }
    }

    private func defaultExpanded() -> Set<Int64> {
        let data = directory.state
        return Set(PeopleDirectory.departments(tree: data.tree, people: data.people).map(\.id))
    }

    static func present(_ data: PeopleState, _ filters: PeopleFilters) -> PeopleUIState {
        let visible = filters.onlineOnly ? data.people.filter { $0.status.isReachable } : data.people
        let searching = !filters.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // В «Отделах» сотрудник видит и себя: счётчики совпадают с десктопом и totalStaffCount сервера.
        let everyone = data.people + [data.selfPerson].compactMap { $0 }
        let tree = filters.scope == .departments
            ? PeopleDirectory.filter(
                PeopleDirectory.departments(tree: data.tree, people: everyone),
                query: filters.query,
                onlineOnly: filters.onlineOnly
            )
            : []
        var state = PeopleUIState()
        state.isLoaded = data.isLoaded
        state.isRefreshing = data.isRefreshing
        state.refreshFailed = data.refreshFailed
        state.total = data.people.count
        state.online = PeopleDirectory.onlineCount(data.people)
        state.query = filters.query
        state.scope = filters.scope
        state.onlineOnly = filters.onlineOnly
        state.sections = filters.scope == .all && !searching ? PeopleDirectory.sections(visible) : []
        state.results = filters.scope == .all && searching ? PeopleSearch.rank(visible, query: filters.query) : []
        state.departments = tree
        // Поиск раскрывает найденные ветки (как на настольном клиенте); фильтр «В сети» — тоже.
        if searching || filters.onlineOnly {
            state.expanded = PeopleDirectory.allIDs(tree)
        } else if let expanded = filters.expanded {
            state.expanded = expanded
        } else {
            state.expanded = Set(tree.map(\.id))
        }
        return state
    }
}

/// «48 сотрудников», «1 сотрудник», «3 сотрудника».
public enum RussianPlural {
    public static func form(_ count: Int, one: String, few: String, many: String) -> String {
        let n = abs(count) % 100
        let last = n % 10
        if n >= 11 && n <= 14 { return many }
        if last == 1 { return one }
        if last >= 2 && last <= 4 { return few }
        return many
    }

    /// Сводка под заголовком «Сотрудников»: «48 сотрудников · 12 в сети».
    public static func peopleSummary(total: Int, online: Int) -> String {
        let noun = form(total, one: String(localized: "сотрудник"), few: String(localized: "сотрудника"), many: String(localized: "сотрудников"))
        return String(localized: "\(total) \(noun) · \(online) в сети")
    }
}
