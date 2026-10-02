import Foundation
import Observation

/// Справочник для экрана «Сотрудники», поиска и карточки.
public struct PeopleState: Equatable, Sendable {
    public var people: [Person] = []
    /// Сам сотрудник: в список не входит, но в «Отделах» и счётчиках он есть, как на десктопе.
    public var selfPerson: Person?
    public var tree: OrgTree?
    /// Есть что показать (из кэша или с сервера).
    public var isLoaded = false
    public var isRefreshing = false
    /// Последнее обновление не удалось; список на экране — прежний.
    public var refreshFailed = false

    public init(
        people: [Person] = [],
        selfPerson: Person? = nil,
        tree: OrgTree? = nil,
        isLoaded: Bool = false,
        isRefreshing: Bool = false,
        refreshFailed: Bool = false
    ) {
        self.people = people
        self.selfPerson = selfPerson
        self.tree = tree
        self.isLoaded = isLoaded
        self.isRefreshing = isRefreshing
        self.refreshFailed = refreshFailed
    }
}

/// Откуда берётся справочник: в приложении — API, в тестах — подделка.
@MainActor
public protocol PeopleSource: Sendable {
    func users() async throws -> [PublicUser]
    func orgTree() async throws -> OrgTree
    func user(id: Int64) async throws -> PublicUser
}

/// Последний справочник на диске, чтобы вкладка открывалась сразу и без сети.
public struct CachedPeople: Codable, Equatable, Sendable {
    public var ownerId: Int64
    public var savedAt: Date
    public var people: [Person]
    public var tree: OrgTree?
    public var selfPerson: Person?
}

@MainActor
public protocol PeopleCache: AnyObject {
    func read() -> CachedPeople?
    func write(_ value: CachedPeople)
    func clear()
}

/// Файл в Application Support: в резервные копии не попадает, защищён шифрованием устройства.
/// Не секрет (тот же справочник видит любой вошедший сотрудник), но после выхода из учётной
/// записи стирается — и при обычном выходе, и при принудительном (см. `PeopleDiskCache.wipe()`).
@MainActor
public final class PeopleDiskCache: PeopleCache {
    nonisolated static let fileName = "people-directory.json"

    private let url: URL?

    public init(directory: URL? = PeopleDiskCache.defaultDirectory()) {
        url = directory?.appendingPathComponent(Self.fileName)
    }

    nonisolated static func defaultDirectory() -> URL? {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return base?.appendingPathComponent("CentyChat", isDirectory: true)
    }

    public func read() -> CachedPeople? {
        guard let url, let data = try? Data(contentsOf: url) else { return nil }
        return try? Self.decoder.decode(CachedPeople.self, from: data)
    }

    public func write(_ value: CachedPeople) {
        guard let url, let data = try? Self.encoder.encode(value) else { return }
        let directory = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var target = url
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? target.setResourceValues(values)
        } catch {
            Log.chat.error("Saving the people cache failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    public func clear() {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Стирает кэш справочника без экземпляра хранилища (экран входа: сессии нет).
    nonisolated public static func wipe() {
        guard let url = defaultDirectory()?.appendingPathComponent(fileName) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

/// Справочник сотрудников сессии: кэш с диска сразу, затем свежий список с сервера
/// (stale-while-revalidate), живое присутствие из `user_status_changed`. Порт
/// `DefaultPeopleRepository` (Android).
@Observable
@MainActor
public final class PeopleStore: RealtimeEventHandling {
    public private(set) var state = PeopleState()

    @ObservationIgnored private let source: any PeopleSource
    @ObservationIgnored private let cache: any PeopleCache
    @ObservationIgnored private let ownerId: () -> Int64?
    @ObservationIgnored private let clock: () -> Date
    @ObservationIgnored private(set) var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var cacheShown = false

    public init(
        source: any PeopleSource,
        cache: any PeopleCache,
        ownerId: @escaping () -> Int64?,
        clock: @escaping () -> Date = Date.init
    ) {
        self.source = source
        self.cache = cache
        self.ownerId = ownerId
        self.clock = clock
    }

    /// Показать кэш (если ещё не показан) и обновить с сервера; повторный вызов во время
    /// загрузки — тот же запрос.
    public func refresh() {
        if let refreshTask, !refreshTask.isCancelled, state.isRefreshing { return }
        state.isRefreshing = true
        let owner = ownerId()
        if !cacheShown {
            cacheShown = true
            if let owner, let cached = cache.read(), cached.ownerId == owner, !state.isLoaded {
                state.people = cached.people
                state.selfPerson = cached.selfPerson
                state.tree = cached.tree
                state.isLoaded = true
            }
        }
        refreshTask = Task { [weak self] in
            await self?.load(owner: owner)
        }
    }

    private func load(owner: Int64?) async {
        let source = self.source
        let treeTask = Task { @MainActor in try? await source.orgTree() }
        let users: [PublicUser]
        do {
            users = try await source.users()
        } catch {
            _ = await treeTask.value
            guard !Task.isCancelled else { return }
            state.isRefreshing = false
            state.refreshFailed = true
            return
        }
        let freshTree = await treeTask.value ?? state.tree
        guard !Task.isCancelled else { return }
        let people = PeopleDirectory.people(users: users, tree: freshTree, selfId: owner)
        let me = owner.flatMap { id in
            PeopleDirectory.people(users: users.filter { $0.id == id }, tree: freshTree, selfId: nil).first
        }
        state = PeopleState(people: people, selfPerson: me, tree: freshTree, isLoaded: true)
        if let owner, ownerId() == owner {
            cache.write(CachedPeople(ownerId: owner, savedAt: clock(), people: people, tree: freshTree, selfPerson: me))
        }
    }

    /// Свежая карточка сотрудника с сервера; обновляет его и в справочнике.
    public func person(id: Int64) async -> Person? {
        guard let user = try? await source.user(id: id) else {
            return state.people.first { $0.id == id }
        }
        let known = state.people.first { $0.id == id }
        let treeName = PeopleDirectory.departmentName(for: user.departmentId, in: state.tree)
        let fresh = Person.from(user, departmentName: .some(treeName ?? user.departmentName ?? known?.departmentName))
        state.people = state.people.map { $0.id == id ? fresh : $0 }
        return fresh
    }

    /// Выход из учётной записи (обычный или принудительный): справочник и кэш стираются.
    public func signOut() {
        refreshTask?.cancel()
        refreshTask = nil
        cacheShown = false
        state = PeopleState()
        cache.clear()
    }

    // MARK: - Realtime

    func handle(_ event: WSServerEvent) {
        guard case .userStatusChanged(let userId, let status, let customStatus) = event else { return }
        applyPresence(userId: userId, status: status, customStatus: customStatus)
    }

    /// Живое присутствие. Сервер всегда присылает `customStatus`: null — свой статус стёрли.
    func applyPresence(userId: Int64, status: UserStatus, customStatus: String?) {
        guard let index = state.people.firstIndex(where: { $0.id == userId }) else { return }
        var person = state.people[index]
        // Ушёл из сети только что: «был(а) в сети сегодня в …» — по этому событию.
        if status == .offline && person.status != .offline {
            person.lastSeen = clock()
        }
        person.status = status
        person.customStatus = customStatus.cleaned
        state.people[index] = person
    }
}

/// Живой источник поверх `APIClient`. Временный адаптер UI-слоя: перенести в
/// `Core/Repositories` (CORE), когда там появятся `orgTree()` и `user(id:)`.
@MainActor
struct APIPeopleSource: PeopleSource {
    let client: APIClient

    func users() async throws -> [PublicUser] {
        try await client.getUsers()
    }

    func orgTree() async throws -> OrgTree {
        try await client.request(endpoint: "/org/tree")
    }

    func user(id: Int64) async throws -> PublicUser {
        try await client.request(endpoint: "/users/\(id)")
    }
}
