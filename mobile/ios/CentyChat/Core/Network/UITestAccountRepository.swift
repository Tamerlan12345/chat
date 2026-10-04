import Foundation

#if DEBUG
/// Backend stand-in for UI tests (`-centychat-stub-account`, UI-test processes only; not in Release).
///
/// The dev stand has no mail server, so the registration code cannot be read from an inbox.
/// This repository plays the server's part for registration and account deletion, and
/// signs a «allowed» registration in against the real dev stand so the rest of the app is real:
///
/// - e-mail `mailoff@…`: the request fails with 503 (mail not configured);
/// - the code is always `123456`; any other code is a 400 «wrong code»;
/// - an e-mail ending in `@allowed.test`: the verify signs in as the stand user from
///   `CENTYCHAT_STUB_SIGNIN` (`login:password`); any other e-mail ends as «pending»;
/// - account deletion checks the password against `CENTYCHAT_STUB_SIGNIN` and, when it
///   matches, wipes the local credentials only (the stand's user is left alone for other tests).
actor UITestAccountRepository: AccountRepository {
    static let verificationCode = "123456"

    private let client: APIClient
    private let keychain: KeychainManager
    private var pendingEmail = ""
    private var blocked: [BlockedUser] = []

    init(client: APIClient, keychain: KeychainManager) {
        self.client = client
        self.keychain = keychain
    }

    private var credentials: (login: String, password: String)? {
        guard let raw = ProcessInfo.processInfo.environment["CENTYCHAT_STUB_SIGNIN"] else { return nil }
        let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        return (parts[0], parts[1])
    }

    func requestRegistration(_ body: RegisterRequestBody) async throws -> RegistrationChallenge {
        if body.email.hasPrefix("mailoff@") {
            throw APIError.httpError(statusCode: 503, message: "Отправка почты не настроена", code: nil)
        }
        pendingEmail = body.email
        return RegistrationChallenge(status: "code_sent", registrationId: "stub-registration", expiresInSec: 600)
    }

    func verifyRegistration(registrationId: String, code: String) async throws -> RegistrationOutcome {
        guard code == Self.verificationCode else {
            throw APIError.httpError(statusCode: 400, message: "Неверный код", code: nil)
        }
        guard pendingEmail.hasSuffix("@allowed.test"), let credentials else {
            return .pending
        }
        let auth = try await client.login(request: LoginRequest(username: credentials.login, password: credentials.password))
        try? keychain.saveUsername(credentials.login)
        return .signedIn(auth)
    }

    func deleteAccount(password: String) async throws {
        guard let credentials, password == credentials.password else {
            throw APIError.httpError(statusCode: 403, message: "Неверный пароль", code: nil)
        }
        try keychain.clearAllUserData()
    }

    func report(_ body: ReportBody) async throws {}

    func blockUser(id: Int64) async throws {
        if !blocked.contains(where: { $0.id == id }) {
            blocked.append(BlockedUser(id: id, name: "Пользователь \(id)"))
        }
    }

    func unblockUser(id: Int64) async throws {
        blocked.removeAll { $0.id == id }
    }

    func blockedUsers() async throws -> [BlockedUser] {
        blocked
    }
}
#endif
