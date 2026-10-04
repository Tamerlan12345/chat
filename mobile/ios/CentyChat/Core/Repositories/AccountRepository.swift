import Foundation

/// Registration, account deletion, reports and blocks. Stores depend on this protocol only.
public protocol AccountRepository: Sendable {
    func requestRegistration(_ body: RegisterRequestBody) async throws -> RegistrationChallenge
    /// Persists the session token when the result is `.signedIn`.
    func verifyRegistration(registrationId: String, code: String) async throws -> RegistrationOutcome
    /// Wipes the local session, device secret and remembered login on success.
    func deleteAccount(password: String) async throws
    func report(_ body: ReportBody) async throws
    func blockUser(id: Int64) async throws
    func unblockUser(id: Int64) async throws
    func blockedUsers() async throws -> [BlockedUser]
}

struct LiveAccountRepository: AccountRepository {
    let client: APIClient
    let keychain: KeychainManager

    func requestRegistration(_ body: RegisterRequestBody) async throws -> RegistrationChallenge {
        try await client.requestRegistration(body)
    }

    func verifyRegistration(registrationId: String, code: String) async throws -> RegistrationOutcome {
        let outcome = try await client.verifyRegistration(registrationId: registrationId, code: code)
        if case .signedIn(let auth) = outcome {
            do {
                try keychain.saveUsername(auth.user.username)
            } catch {
                Log.session.error("Remembering the login name failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        return outcome
    }

    func deleteAccount(password: String) async throws {
        try await client.deleteAccount(password: password)
    }

    func report(_ body: ReportBody) async throws {
        try await client.report(body)
    }

    func blockUser(id: Int64) async throws {
        try await client.blockUser(id: id)
    }

    func unblockUser(id: Int64) async throws {
        try await client.unblockUser(id: id)
    }

    func blockedUsers() async throws -> [BlockedUser] {
        try await client.getBlockedUsers()
    }
}

/// Used where no account backend is wired (previews, unit tests that do not touch accounts).
struct UnavailableAccountRepository: AccountRepository {
    func requestRegistration(_ body: RegisterRequestBody) async throws -> RegistrationChallenge { throw APIError.noConnection }
    func verifyRegistration(registrationId: String, code: String) async throws -> RegistrationOutcome { throw APIError.noConnection }
    func deleteAccount(password: String) async throws { throw APIError.noConnection }
    func report(_ body: ReportBody) async throws { throw APIError.noConnection }
    func blockUser(id: Int64) async throws { throw APIError.noConnection }
    func unblockUser(id: Int64) async throws { throw APIError.noConnection }
    func blockedUsers() async throws -> [BlockedUser] { throw APIError.noConnection }
}
