import Foundation
import Observation

/// Why a login attempt failed, as shown to the user.
///
/// Messages are fixed client copy: server error text is never shown, so the form cannot
/// reveal whether a login exists or leak server internals.
public enum LoginFailure: Equatable, Sendable {
    /// Wrong login or password (also unknown, disabled or unapproved accounts).
    case invalidCredentials
    /// `429`: too many attempts; wait until the deadline.
    case throttled(until: Date)
    /// `503` (`LOGIN_BUSY`, `PASSWORD_HASH_BUSY`): the server is busy checking passwords.
    case serverBusy(until: Date)
    case offline
    /// The session could not be stored securely on this device.
    case storage
    case unavailable

    static let defaultThrottleWait: TimeInterval = 60
    static let defaultBusyWait: TimeInterval = 5

    init(_ error: any Error, now: Date) {
        switch error {
        case let apiError as APIError:
            self = Self.classify(apiError, now: now)
        case is KeychainManagerError:
            self = .storage
        case is URLError:
            self = .offline
        default:
            self = .unavailable
        }
    }

    private static func classify(_ error: APIError, now: Date) -> LoginFailure {
        switch error {
        case .httpError(let status, _, _, let retryAfter):
            switch status {
            case 429:
                return .throttled(until: now.addingTimeInterval(retryAfter ?? defaultThrottleWait))
            case 503:
                return .serverBusy(until: now.addingTimeInterval(retryAfter ?? defaultBusyWait))
            case 400, 401, 403, 404:
                return .invalidCredentials
            default:
                return .unavailable
            }
        case .unauthorized:
            return .invalidCredentials
        case .noConnection:
            return .offline
        default:
            return .unavailable
        }
    }

    /// When another attempt is allowed, for failures that impose a wait.
    var retryDeadline: Date? {
        switch self {
        case .throttled(let until), .serverBusy(let until):
            return until
        default:
            return nil
        }
    }

    /// The text for the error box at `date`, or nil once a wait is over.
    func message(at date: Date) -> String? {
        switch self {
        case .invalidCredentials:
            return String(localized: "Неверный логин или пароль")
        case .throttled(let until):
            guard let wait = Self.remaining(until: until, at: date) else { return nil }
            return String(localized: "Слишком много попыток входа. Повторите через \(wait).")
        case .serverBusy(let until):
            guard let wait = Self.remaining(until: until, at: date) else { return nil }
            return String(localized: "Сервер обрабатывает много входов. Повторите через \(wait).")
        case .offline:
            return String(localized: "Нет связи с сервером. Проверьте подключение к интернету.")
        case .storage:
            return String(localized: "Не удалось надёжно сохранить данные сессии на этом устройстве.")
        case .unavailable:
            return String(localized: "Не удалось войти. Повторите попытку позже.")
        }
    }

    /// "42 с", "1 мин", "2 мин 30 с"; nil when the deadline has passed.
    private static func remaining(until deadline: Date, at date: Date) -> String? {
        let total = Int(deadline.timeIntervalSince(date).rounded(.up))
        guard total > 0 else { return nil }
        let minutes = total / 60
        let seconds = total % 60
        if minutes == 0 {
            return String(localized: "\(seconds) с")
        }
        if seconds == 0 {
            return String(localized: "\(minutes) мин")
        }
        return String(localized: "\(minutes) мин \(seconds) с")
    }
}

/// State of the login form. The password lives only here, in memory, until the request is
/// sent; it is never logged or persisted and is cleared after a successful login.
@Observable
@MainActor
public final class LoginFormModel {
    public var username = ""
    public var password = ""
    public private(set) var isSubmitting = false
    public private(set) var failure: LoginFailure?

    @ObservationIgnored private let now: @MainActor () -> Date
    @ObservationIgnored private var didPrefill = false

    public init(now: @escaping @MainActor () -> Date = { Date() }) {
        self.now = now
    }

    /// Fills in the last login name that worked, once, unless the user already typed one.
    public func prefill(username saved: String?) {
        guard !didPrefill else { return }
        didPrefill = true
        if username.isEmpty, let saved, !saved.isEmpty {
            username = saved
        }
    }

    public var hasRequiredFields: Bool {
        !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
    }

    /// «Войти» is enabled only with both fields filled, no request in flight and no wait pending.
    public func canSubmit(at date: Date) -> Bool {
        guard hasRequiredFields, !isSubmitting else { return false }
        if let deadline = failure?.retryDeadline, date < deadline {
            return false
        }
        return true
    }

    public func errorMessage(at date: Date) -> String? {
        failure?.message(at: date)
    }

    /// Sends one login request. Ignored (returns nil) while another is in flight or a
    /// throttling wait is pending, so the server never sees a double submit or a retry loop.
    @discardableResult
    public func submit(using login: (String, String) async throws -> LoginOutcome) async -> LoginOutcome? {
        guard canSubmit(at: now()) else { return nil }
        isSubmitting = true
        defer { isSubmitting = false }
        failure = nil
        do {
            let outcome = try await login(username, password)
            password = ""
            return outcome
        } catch {
            failure = LoginFailure(error, now: now())
            return nil
        }
    }
}

/// Copy shown next to the brand mark.
public enum BrandCopy {
    public static let companyNameLimit = 80

    /// `company_name` from the server, rendered as plain text: control and bidi-override
    /// characters removed, whitespace collapsed, capped at `companyNameLimit` characters.
    /// Falls back to «Корпоративный мессенджер».
    public static func companyLine(_ raw: String?) -> String {
        let fallback = String(localized: "Корпоративный мессенджер")
        guard let raw else { return fallback }
        let visible = String(String.UnicodeScalarView(raw.unicodeScalars.map { scalar -> Unicode.Scalar in
            switch scalar.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator:
                return " "
            default:
                return scalar
            }
        }))
        let collapsed = visible
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        guard !collapsed.isEmpty else { return fallback }
        guard collapsed.count > companyNameLimit else { return collapsed }
        let trimmed = collapsed.prefix(companyNameLimit - 1).trimmingCharacters(in: .whitespaces)
        return trimmed + "…"
    }
}
