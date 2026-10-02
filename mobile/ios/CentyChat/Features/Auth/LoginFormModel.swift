import Foundation
import Observation

/// Why a login attempt failed, as shown to the user.
public enum LoginFailure: Equatable, Sendable {
    case invalidCredentials
    case throttled(until: Date)
    case serverBusy(until: Date)
    case offline
    case storage
    case unavailable

    init(_ error: any Error, now: Date) {
        self = .unavailable
    }

    var retryDeadline: Date? { nil }

    func message(at date: Date) -> String? { nil }
}

/// State of the login form.
@Observable
@MainActor
public final class LoginFormModel {
    public var username = ""
    public var password = ""
    public private(set) var isSubmitting = false
    public private(set) var failure: LoginFailure?

    @ObservationIgnored private let now: @MainActor () -> Date

    public init(now: @escaping @MainActor () -> Date = { Date() }) {
        self.now = now
    }

    public func prefill(username saved: String?) {}

    public func canSubmit(at date: Date) -> Bool {
        !username.isEmpty && !password.isEmpty
    }

    public func errorMessage(at date: Date) -> String? { nil }

    @discardableResult
    public func submit(using login: (String, String) async throws -> LoginOutcome) async -> LoginOutcome? {
        isSubmitting = true
        defer { isSubmitting = false }
        return try? await login(username, password)
    }
}

/// Copy shown next to the brand mark.
public enum BrandCopy {
    public static let companyNameLimit = 80

    public static func companyLine(_ raw: String?) -> String {
        raw ?? ""
    }
}
