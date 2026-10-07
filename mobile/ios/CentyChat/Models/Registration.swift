import Foundation

// MARK: - Registration (POST /api/auth/register/request, /verify)

/// Запрос кода подтверждения на почту (POST /api/auth/register/request)
public struct RegisterRequestBody: Codable, Sendable, Equatable {
    public let email: String
    public let username: String
    public let displayName: String
    public let password: String

    public init(email: String, username: String, displayName: String, password: String) {
        self.email = email
        self.username = username
        self.displayName = displayName
        self.password = password
    }
}

/// `202 { status: "code_sent", registrationId, expiresInSec }`
public struct RegistrationChallenge: Codable, Sendable, Equatable {
    public let status: String
    public let registrationId: String
    public let expiresInSec: Int
}

/// Подтверждение почты кодом (POST /api/auth/register/verify)
public struct RegisterVerifyBody: Codable, Sendable, Equatable {
    public let registrationId: String
    public let code: String

    public init(registrationId: String, code: String) {
        self.registrationId = registrationId
        self.code = code
    }
}

/// Результат подтверждения: вход сразу (почта в списке разрешённых) или заявка на рассмотрении.
public enum RegistrationOutcome: Sendable, Equatable {
    case signedIn(AuthSuccessResponse)
    case pending
}

extension AuthSuccessResponse: Equatable {
    public static func == (lhs: AuthSuccessResponse, rhs: AuthSuccessResponse) -> Bool {
        lhs.token == rhs.token && lhs.user.id == rhs.user.id
    }
}

/// `200` — как успешный вход (`user` + `token`); `202 { status: "pending" }` — ждёт администратора.
public struct RegisterVerifyResponse: Decodable, Sendable {
    public let outcome: RegistrationOutcome

    private enum CodingKeys: String, CodingKey {
        case status
        case user
        case token
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let token = try container.decodeIfPresent(String.self, forKey: .token), !token.isEmpty {
            let user = try container.decode(User.self, forKey: .user)
            outcome = .signedIn(AuthSuccessResponse(user: user, token: token))
        } else if try container.decodeIfPresent(String.self, forKey: .status) == "pending" {
            outcome = .pending
        } else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "Neither a session nor a pending status"
            ))
        }
    }
}

/// Коды `403` при входе в ещё не одобренную или отклонённую учётную запись.
public enum AccountStateCode {
    public static let pending = "ACCOUNT_PENDING"
    public static let rejected = "ACCOUNT_REJECTED"
}

// MARK: - Account deletion (DELETE /api/users/me)

public struct DeleteAccountBody: Codable, Sendable, Equatable {
    public let password: String

    public init(password: String) {
        self.password = password
    }
}

/// Ответ, тело которого не важно (пустое или любое JSON).
public struct IgnoredBody: Decodable, Sendable {
    public init() {}
    public init(from decoder: any Decoder) throws {}
}

// MARK: - Reports and blocks

public enum ReportTargetType: String, Codable, Sendable, Equatable {
    case message
    case user
}

/// Причина жалобы: код уходит на сервер, подпись видит пользователь.
public enum ReportReason: String, CaseIterable, Sendable, Identifiable {
    case spam
    case abuse
    case inappropriate
    case threat
    case other

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .spam: return String(localized: "Спам или реклама")
        case .abuse: return String(localized: "Оскорбления или травля")
        case .inappropriate: return String(localized: "Недопустимое содержимое")
        case .threat: return String(localized: "Угрозы или опасные действия")
        case .other: return String(localized: "Другое")
        }
    }
}

/// POST /api/reports
public struct ReportBody: Codable, Sendable, Equatable {
    public let targetType: ReportTargetType
    public let targetId: Int64
    public let reason: String
    public let details: String?

    public init(targetType: ReportTargetType, targetId: Int64, reason: String, details: String?) {
        self.targetType = targetType
        self.targetId = targetId
        self.reason = reason
        self.details = details
    }
}

/// `201 { id, status }` of POST /api/reports.
public struct ReportCreatedResponse: Decodable, Sendable, Equatable {
    public let id: Int64
    public let status: String
}

/// POST /api/blocks
public struct BlockBody: Codable, Sendable, Equatable {
    public let userId: Int64

    public init(userId: Int64) {
        self.userId = userId
    }
}

/// Заблокированный пользователь из GET /api/blocks. Разбор терпим к форме ответа сервера:
/// и `id`, и `userId`/`user_id`; имя из `fullName`/`full_name`/`displayName`/`username`.
public struct BlockedUser: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int64
    public let name: String

    public init(id: Int64, name: String) {
        self.id = id
        self.name = name
    }

    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int?
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { self.stringValue = "\(intValue)"; self.intValue = intValue }
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: AnyKey.self)
        func int(_ keys: [String]) -> Int64? {
            for key in keys {
                if let value = try? container.decodeIfPresent(Int64.self, forKey: AnyKey(stringValue: key)!) {
                    return value
                }
            }
            return nil
        }
        func string(_ keys: [String]) -> String? {
            for key in keys {
                if let value = try? container.decodeIfPresent(String.self, forKey: AnyKey(stringValue: key)!), !value.isEmpty {
                    return value
                }
            }
            return nil
        }
        guard let id = int(["userId", "user_id", "blockedUserId", "blocked_user_id", "id"]) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Blocked user without an id"))
        }
        self.id = id
        self.name = string(["fullName", "full_name", "displayName", "display_name", "username"])
            ?? String(localized: "Пользователь")
    }
}

/// GET /api/blocks: массив или `{ blocks: [...] }` / `{ users: [...] }`.
public struct BlockListResponse: Decodable, Sendable {
    public let blocked: [BlockedUser]

    private enum CodingKeys: String, CodingKey {
        case blocks
        case users
        case blocked
    }

    public init(from decoder: any Decoder) throws {
        if let array = try? [BlockedUser](from: decoder) {
            blocked = array
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        for key in [CodingKeys.blocks, .users, .blocked] {
            if let list = try container.decodeIfPresent([BlockedUser].self, forKey: key) {
                blocked = list
                return
            }
        }
        blocked = []
    }
}
