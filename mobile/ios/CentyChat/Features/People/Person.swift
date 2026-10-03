import Foundation

/// Сотрудник в справочнике: только то, что показывают список, поиск и карточка. Хранится и в
/// дисковом кэше справочника (не секрет: тот же справочник видит любой вошедший сотрудник).
/// Порт `features/people/Person.kt` (Android).
public struct Person: Identifiable, Codable, Sendable, Equatable, Hashable {
    public let id: Int64
    public var fullName: String
    public var username: String
    public var jobTitle: String?
    public var departmentId: Int64?
    public var departmentName: String?
    public var `extension`: String?
    public var phone: String?
    public var email: String?
    public var avatarUrl: String?
    public var status: UserStatus
    public var customStatus: String?
    public var lastSeen: Date?
    public var roleName: String?
    /// false — сотрудник уволен (карточка из старого чата): действия недоступны.
    public var isActive: Bool

    public init(
        id: Int64,
        fullName: String,
        username: String = "",
        jobTitle: String? = nil,
        departmentId: Int64? = nil,
        departmentName: String? = nil,
        extension: String? = nil,
        phone: String? = nil,
        email: String? = nil,
        avatarUrl: String? = nil,
        status: UserStatus = .offline,
        customStatus: String? = nil,
        lastSeen: Date? = nil,
        roleName: String? = nil,
        isActive: Bool = true
    ) {
        self.id = id
        self.fullName = fullName
        self.username = username
        self.jobTitle = jobTitle
        self.departmentId = departmentId
        self.departmentName = departmentName
        self.extension = `extension`
        self.phone = phone
        self.email = email
        self.avatarUrl = avatarUrl
        self.status = status
        self.customStatus = customStatus
        self.lastSeen = lastSeen
        self.roleName = roleName
        self.isActive = isActive
    }

    /// «Должность · Отдел» для второй строки, без пустых частей.
    public var subtitle: String {
        [jobTitle, departmentName]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    /// Коллега из `/api/users` (справочник сервера уже без неодобренных заявок).
    public static func from(_ user: PublicUser, departmentName: String?? = .none, approvalStatus: String? = nil) -> Person {
        Person(
            id: user.id,
            fullName: user.fullName.cleaned ?? user.username,
            username: user.username,
            jobTitle: user.jobTitle.cleaned,
            departmentId: user.departmentId,
            departmentName: (departmentName ?? user.departmentName).cleaned,
            extension: user.extension.cleaned,
            phone: user.phone.cleaned,
            email: user.email.cleaned,
            avatarUrl: user.avatarUrl,
            status: user.status,
            customStatus: user.customStatus.cleaned,
            lastSeen: user.lastSeen,
            roleName: user.roleName.cleaned,
            isActive: user.isActive && (approvalStatus ?? "approved") == "approved"
        )
    }

    /// Сам сотрудник (своя карточка и счётчики «Отделов»).
    public static func from(_ user: User, departmentName: String?? = .none) -> Person {
        Person(
            id: user.id,
            fullName: user.fullName.cleaned ?? user.username,
            username: user.username,
            jobTitle: user.jobTitle.cleaned,
            departmentId: user.departmentId,
            departmentName: (departmentName ?? user.departmentName).cleaned,
            extension: user.extension.cleaned,
            phone: user.phone.cleaned,
            email: user.email.cleaned,
            avatarUrl: user.avatarUrl,
            status: user.status,
            customStatus: user.customStatus.cleaned,
            lastSeen: user.lastSeen,
            roleName: user.roleName.cleaned,
            isActive: user.isActive && user.approvalStatus == "approved"
        )
    }
}

public extension UserStatus {
    /// «В сети» в справочнике — как на настольном клиенте и в счётчиках `/api/org/tree`: и
    /// `online`, и `away`. «Не беспокоить» сюда не входит.
    var isReachable: Bool { self == .online || self == .away }
}

extension Optional where Wrapped == String {
    /// Обрезанная строка или nil, если она пустая.
    var cleaned: String? {
        guard let value = self?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}

extension String {
    var cleaned: String? { Optional(self).cleaned }
}
