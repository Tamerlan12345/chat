import Foundation
import Observation

/// Можно ли позвонить из карточки. Право — своё (`can_call` текущего сотрудника: `/api/users` не
/// отдаёт права коллег), затем «Не беспокоить» (сервер ответит `call_unavailable`), затем
/// «не в сети». Порт `CallAvailability` (Android).
public enum CallAvailability: Equatable, Sendable {
    case available
    /// «Звонки недоступны»: роли текущего сотрудника звонки не разрешены.
    case notPermitted
    /// «Не беспокоить»: сервер не пропустит вызов.
    case peerDoNotDisturb
    /// «Не в сети»: звонок некуда доставить.
    case peerOffline

    public static func of(_ myPermissions: RolePermissions?, peerStatus: UserStatus) -> CallAvailability {
        if let myPermissions, !myPermissions.canCall { return .notPermitted }
        if peerStatus == .dnd { return .peerDoNotDisturb }
        if peerStatus == .offline { return .peerOffline }
        return .available
    }

    /// Строка под кнопками, когда звонить нельзя.
    public var reason: String? {
        switch self {
        case .available: return nil
        case .notPermitted: return String(localized: "Звонки недоступны для вашей роли")
        case .peerDoNotDisturb: return String(localized: "Не беспокоить — звонок не пройдёт")
        case .peerOffline: return String(localized: "Не в сети — звонок сейчас не дойдёт")
        }
    }
}

/// Карточка сотрудника. Порт `PersonViewModel` (Android).
@Observable
@MainActor
public final class PersonCardModel: RealtimeEventHandling {
    public static let wakeCooldownSeconds = 60

    public let userId: Int64
    /// Секунды до следующей побудки; 0 — можно.
    public private(set) var wakeCooldown = 0
    /// Карточка, полученная с сервера, когда в справочнике этого сотрудника нет.
    private var fetched: Person?

    @ObservationIgnored private let directory: any PeopleProviding
    @ObservationIgnored private let currentUser: () -> User?
    @ObservationIgnored private let requests: PeopleRequests
    @ObservationIgnored private let sendWake: (Int64) async -> Void
    @ObservationIgnored private var wakeTimer: Task<Void, Never>?
    @ObservationIgnored private let now: () -> Date

    public init(
        userId: Int64,
        directory: any PeopleProviding,
        currentUser: @escaping () -> User?,
        requests: PeopleRequests,
        sendWake: @escaping (Int64) async -> Void,
        now: @escaping () -> Date = Date.init
    ) {
        self.userId = userId
        self.directory = directory
        self.currentUser = currentUser
        self.requests = requests
        self.sendWake = sendWake
        self.now = now
    }

    public var isSelf: Bool { currentUser()?.id == userId }

    public var person: Person? {
        if isSelf, let me = currentUser() {
            return Person.from(me, departmentName: .some(
                PeopleDirectory.departmentName(for: me.departmentId, in: directory.state.tree) ?? me.departmentName
            ))
        }
        return directory.state.people.first { $0.id == userId } ?? fetched
    }

    public var call: CallAvailability {
        CallAvailability.of(currentUser()?.permissions, peerStatus: person?.status ?? .offline)
    }

    /// Сотрудник больше не работает (карточка из старого чата): действия недоступны.
    public var inactive: Bool { person?.isActive == false }

    /// Свежие поля карточки (телефон, почта могли поменяться); справочник обновится тоже.
    public func load() async {
        guard !isSelf else { return }
        let fresh = await directory.person(id: userId)
        if let fresh, !directory.state.people.contains(where: { $0.id == userId }) {
            fetched = fresh
        }
    }

    /// «Отдел» в карточке: «Сотрудники › Отделы» с раскрытой веткой этого отдела.
    public func showDepartment() {
        guard let id = person?.departmentId else { return }
        requests.send(.department(id))
    }

    /// «Побудить»: сигнал и вибрация у коллеги; повторно — через минуту.
    public func wake() {
        guard !isSelf, wakeCooldown == 0, !inactive else { return }
        startCooldown(Self.wakeCooldownSeconds)
        let target = userId
        let send = sendWake
        Task { await send(target) }
    }

    func handle(_ event: WSServerEvent) {
        guard case .wakeSent(let targetUserId, _, let retryAt) = event, targetUserId == userId else { return }
        let nowMs = Int64(now().timeIntervalSince1970 * 1000)
        let remaining = max(0, Int((retryAt - nowMs) / 1000))
        startCooldown(max(remaining, Self.wakeCooldownSeconds))
    }

    private func startCooldown(_ seconds: Int) {
        wakeTimer?.cancel()
        wakeCooldown = seconds
        wakeTimer = Task { [weak self] in
            while let self, self.wakeCooldown > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                self.wakeCooldown -= 1
            }
        }
    }
}
