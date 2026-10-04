import Foundation
import XCTest
@testable import CentyChat

/// Registration, account deletion, reports and blocks against the scripted stub server
/// (`RecordingURLProtocol`): request shapes, DTO decoding and error mapping.
final class RegistrationAPITests: XCTestCase {
    private let userJSON = #"{"id":7,"username":"newbie","full_name":"Новый Сотрудник","is_active":1,"must_change_password":0}"#

    private func makeClient(
        routes: [String: RecordingURLProtocol.StubResponse],
        token: String? = nil,
        savedUsername: String? = nil
    ) -> (client: APIClient, keychain: KeychainManager, store: SeededKeychainItemStore) {
        let store = SeededKeychainItemStore()
        if let token { store.seed("auth_token", token) }
        if let savedUsername { store.seed("saved_username", savedUsername) }
        let keychain = KeychainManager(testStore: store)
        RecordingURLProtocol.reset(routes: routes)
        let client = APIClient(session: RecordingURLProtocol.session(), keychain: keychain, environment: .test)
        return (client, keychain, store)
    }

    private func body(of request: RecordingURLProtocol.RecordedRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.body, "The request has no body")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func failure(_ error: any Error, _ context: AccountFailure.Context) -> AccountFailure {
        AccountFailure(error, context: context, now: Date(timeIntervalSince1970: 1_000))
    }

    // MARK: - Request code

    func testRequestRegistrationSendsTheContractBodyWithoutAuthorization() async throws {
        let (client, _, _) = makeClient(routes: [
            "/api/auth/register/request": .init(
                status: 202,
                body: #"{"status":"code_sent","registrationId":"reg-1","expiresInSec":600}"#
            ),
        ], token: "stale-token")

        let challenge = try await client.requestRegistration(RegisterRequestBody(
            email: "ivan@company.kz", username: "ivan", displayName: "Иван Иванов", password: "Str0ng-Passw0rd"
        ))

        XCTAssertEqual(challenge, RegistrationChallenge(status: "code_sent", registrationId: "reg-1", expiresInSec: 600))
        let request = try XCTUnwrap(RecordingURLProtocol.requests.last)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url?.path, "/api/auth/register/request")
        XCTAssertNil(request.headers["Authorization"], "Registration happens before any session")
        let sent = try body(of: request)
        XCTAssertEqual(sent["email"] as? String, "ivan@company.kz")
        XCTAssertEqual(sent["username"] as? String, "ivan")
        XCTAssertEqual(sent["displayName"] as? String, "Иван Иванов")
        XCTAssertEqual(sent["password"] as? String, "Str0ng-Passw0rd")
    }

    func testRequestRegistrationErrorsAreMapped() async {
        let cases: [(RecordingURLProtocol.StubResponse, AccountFailure)] = [
            (.init(status: 400, body: #"{"error":"Пароль должен быть не короче 8 символов"}"#),
             .invalidInput("Пароль должен быть не короче 8 символов")),
            (.init(status: 409, body: #"{"error":"Логин уже занят"}"#), .conflict("Логин уже занят")),
            (.init(status: 429, headers: ["Retry-After": "30"], body: #"{"error":"Слишком часто"}"#),
             .throttled(until: Date(timeIntervalSince1970: 1_030))),
            (.init(status: 503, body: #"{"error":"Отправка почты не настроена"}"#), .mailNotConfigured),
            (.init(status: 503, body: #"{"error":"busy","code":"PASSWORD_HASH_BUSY"}"#),
             .throttled(until: Date(timeIntervalSince1970: 1_005))),
            (.init(status: 500, body: "{}"), .unavailable),
        ]
        for (response, expected) in cases {
            let (client, _, _) = makeClient(routes: ["/api/auth/register/request": response])
            do {
                _ = try await client.requestRegistration(RegisterRequestBody(email: "a@b.kz", username: "abc", displayName: "Аб", password: "12345678"))
                XCTFail("Status \(response.status) must fail")
            } catch {
                XCTAssertEqual(failure(error, .registrationRequest), expected, "Status \(response.status)")
            }
        }
    }

    func testNoConnectionIsReportedAsOffline() async {
        // No route: the stub fails the connection.
        let (client, _, _) = makeClient(routes: [:])
        do {
            _ = try await client.requestRegistration(RegisterRequestBody(email: "a@b.kz", username: "abc", displayName: "Аб", password: "12345678"))
            XCTFail("An unreachable server must fail")
        } catch {
            XCTAssertEqual(failure(error, .registrationRequest), .offline)
        }
    }

    // MARK: - Verify

    func testVerifySignedInDecodesTheSessionAndStoresTheToken() async throws {
        let (client, keychain, _) = makeClient(routes: [
            "/api/auth/register/verify": .init(status: 200, body: #"{"user":\#(userJSON),"token":"issued-token"}"#),
        ])

        let outcome = try await client.verifyRegistration(registrationId: "reg-1", code: "123456")

        guard case .signedIn(let auth) = outcome else { return XCTFail("Expected a session, got \(outcome)") }
        XCTAssertEqual(auth.user.username, "newbie")
        XCTAssertEqual(auth.token, "issued-token")
        XCTAssertEqual(keychain.authToken, "issued-token")
        let request = try XCTUnwrap(RecordingURLProtocol.requests.last)
        let sent = try body(of: request)
        XCTAssertEqual(sent["registrationId"] as? String, "reg-1")
        XCTAssertEqual(sent["code"] as? String, "123456")
        XCTAssertNil(request.headers["Authorization"])
    }

    func testVerifyPendingStoresNoToken() async throws {
        let (client, keychain, _) = makeClient(routes: [
            "/api/auth/register/verify": .init(status: 202, body: #"{"status":"pending"}"#),
        ])

        let outcome = try await client.verifyRegistration(registrationId: "reg-1", code: "123456")

        XCTAssertEqual(outcome, .pending)
        XCTAssertNil(keychain.authToken)
    }

    func testVerifyWithAnUnknownBodyFailsToDecode() async {
        let (client, keychain, _) = makeClient(routes: [
            "/api/auth/register/verify": .init(status: 200, body: #"{"status":"weird"}"#),
        ])
        do {
            _ = try await client.verifyRegistration(registrationId: "reg-1", code: "123456")
            XCTFail("An answer without a session or a pending status is not a success")
        } catch APIError.decodingError {
            XCTAssertNil(keychain.authToken)
        } catch {
            XCTFail("Unexpected \(error)")
        }
    }

    func testVerifyErrorsAreMapped() async {
        let cases: [(RecordingURLProtocol.StubResponse, AccountFailure)] = [
            (.init(status: 400, body: #"{"error":"Неверный код"}"#), .wrongCode("Неверный код")),
            (.init(status: 410, body: #"{"error":"Код истёк"}"#), .codeExpired),
            (.init(status: 400, body: #"{"error":"x","code":"CODE_EXPIRED"}"#), .codeExpired),
            (.init(status: 429, body: #"{"error":"Слишком много попыток"}"#), .tooManyCodeAttempts),
            (.init(status: 409, body: #"{"error":"Логин уже занят"}"#), .conflict("Логин уже занят")),
        ]
        for (response, expected) in cases {
            let (client, _, _) = makeClient(routes: ["/api/auth/register/verify": response])
            do {
                _ = try await client.verifyRegistration(registrationId: "reg-1", code: "000000")
                XCTFail("Status \(response.status) must fail")
            } catch {
                XCTAssertEqual(failure(error, .registrationVerify), expected, "Status \(response.status) \(response.body)")
            }
        }
    }

    // MARK: - Delete account

    func testDeleteAccountSendsThePasswordAndWipesLocalCredentials() async throws {
        let (client, keychain, store) = makeClient(
            routes: ["/api/users/me": .init(status: 200, body: "")],
            token: "session-token",
            savedUsername: "ivan"
        )
        store.seed("device_secret", "device-secret")

        try await client.deleteAccount(password: "Str0ng-Passw0rd")

        let request = try XCTUnwrap(RecordingURLProtocol.requests.last)
        XCTAssertEqual(request.method, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/users/me")
        XCTAssertEqual(request.headers["Authorization"], "Bearer session-token")
        XCTAssertEqual(try body(of: request)["password"] as? String, "Str0ng-Passw0rd")
        XCTAssertNil(keychain.authToken)
        XCTAssertNil(keychain.deviceSecret)
        XCTAssertNil(keychain.savedUsername)
    }

    func testDeleteAccountAcceptsAJSONBody() async throws {
        let (client, keychain, _) = makeClient(
            routes: ["/api/users/me": .init(status: 200, body: #"{"success":true}"#)],
            token: "session-token"
        )
        try await client.deleteAccount(password: "Str0ng-Passw0rd")
        XCTAssertNil(keychain.authToken)
    }

    func testDeleteAccountWrongPasswordKeepsTheSession() async {
        for status in [400, 401, 403] {
            let (client, keychain, _) = makeClient(
                routes: [
                    "/api/users/me": .init(status: status, body: #"{"error":"Неверный пароль"}"#),
                    "/api/auth/refresh": .init(status: 200, body: #"{"token":"refreshed"}"#),
                ],
                token: "session-token",
                savedUsername: "ivan"
            )
            do {
                try await client.deleteAccount(password: "wrong")
                XCTFail("Status \(status) must fail")
            } catch {
                XCTAssertEqual(failure(error, .deleteAccount), .wrongPassword, "Status \(status)")
            }
            XCTAssertEqual(keychain.authToken, "session-token", "A refused password must not sign the user out (\(status))")
            XCTAssertEqual(keychain.savedUsername, "ivan")
            XCTAssertFalse(
                RecordingURLProtocol.requests.contains { $0.url?.path == "/api/auth/refresh" },
                "A refused password is not an expired session (\(status))"
            )
        }
    }

    // MARK: - Reports and blocks

    func testReportPostsTheTargetReasonAndDetails() async throws {
        let (client, _, _) = makeClient(
            routes: ["/api/reports": .init(status: 201, body: #"{"id":1}"#)],
            token: "session-token"
        )

        try await client.report(ReportBody(targetType: .message, targetId: 42, reason: "spam", details: "Реклама"))

        let request = try XCTUnwrap(RecordingURLProtocol.requests.last)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.headers["Authorization"], "Bearer session-token")
        let sent = try body(of: request)
        XCTAssertEqual(sent["targetType"] as? String, "message")
        XCTAssertEqual(sent["targetId"] as? Int, 42)
        XCTAssertEqual(sent["reason"] as? String, "spam")
        XCTAssertEqual(sent["details"] as? String, "Реклама")
    }

    func testReportWithoutDetailsOmitsTheKey() async throws {
        let (client, _, _) = makeClient(
            routes: ["/api/reports": .init(status: 201, body: "")],
            token: "session-token"
        )
        try await client.report(ReportBody(targetType: .user, targetId: 9, reason: "abuse", details: nil))
        let sent = try body(of: try XCTUnwrap(RecordingURLProtocol.requests.last))
        XCTAssertEqual(sent["targetType"] as? String, "user")
        XCTAssertNil(sent["details"])
    }

    func testBlockAndUnblockUseTheContractRoutes() async throws {
        let (client, _, _) = makeClient(
            routes: [
                "/api/blocks": .init(status: 201, body: ""),
                "/api/blocks/12": .init(status: 200, body: #"{"success":true}"#),
            ],
            token: "session-token"
        )

        try await client.blockUser(id: 12)
        try await client.unblockUser(id: 12)

        let requests = RecordingURLProtocol.requests
        XCTAssertEqual(requests.map { $0.method ?? "" }, ["POST", "DELETE"])
        XCTAssertEqual(requests.map { $0.url?.path ?? "" }, ["/api/blocks", "/api/blocks/12"])
        XCTAssertEqual(try body(of: requests[0])["userId"] as? Int, 12)
    }

    func testBlockListDecodesArraysAndWrappedLists() async throws {
        let shapes = [
            #"[{"id":3,"full_name":"Данияр"},{"userId":4,"fullName":"Айгерим"}]"#,
            #"{"blocks":[{"user_id":3,"full_name":"Данияр"},{"blocked_user_id":4,"username":"aigerim"}]}"#,
        ]
        for shape in shapes {
            let (client, _, _) = makeClient(
                routes: ["/api/blocks": .init(status: 200, body: shape)],
                token: "session-token"
            )
            let list = try await client.getBlockedUsers()
            XCTAssertEqual(list.map(\.id), [3, 4], shape)
        }
        let (client, _, _) = makeClient(routes: ["/api/blocks": .init(status: 200, body: "[]")], token: "session-token")
        let empty = try await client.getBlockedUsers()
        XCTAssertTrue(empty.isEmpty)
    }

    // MARK: - Login of an account that is not active yet

    @MainActor
    func testLoginMapsPendingAndRejectedAccounts() async {
        let pending = LoginFailure(
            APIError.httpError(statusCode: 403, message: "x", code: "ACCOUNT_PENDING"),
            now: Date()
        )
        let rejected = LoginFailure(
            APIError.httpError(statusCode: 403, message: "x", code: "ACCOUNT_REJECTED"),
            now: Date()
        )
        let plain403 = LoginFailure(APIError.httpError(statusCode: 403, message: "x", code: nil), now: Date())

        XCTAssertEqual(pending, .accountPending)
        XCTAssertEqual(rejected, .accountRejected)
        XCTAssertEqual(plain403, .invalidCredentials)
        let pendingText = try? XCTUnwrap(pending.message(at: Date()))
        XCTAssertTrue(pendingText?.contains("администратором") == true, pendingText ?? "")
        XCTAssertNotEqual(pending.message(at: Date()), rejected.message(at: Date()))
        XCTAssertNil(pending.retryDeadline)
    }

    func testLoginOfAPendingAccountOverTheWireShowsThePendingMessage() async throws {
        let (client, keychain, _) = makeClient(routes: [
            "/api/auth/login": .init(
                status: 403,
                body: #"{"error":"Заявка на рассмотрении","code":"ACCOUNT_PENDING"}"#
            ),
        ])
        do {
            _ = try await client.login(request: LoginRequest(username: "newbie", password: "pw"))
            XCTFail("A pending account cannot sign in")
        } catch {
            XCTAssertEqual(LoginFailure(error, now: Date()), .accountPending)
            XCTAssertNil(keychain.authToken)
        }
    }

    // MARK: - Messages

    func testFailureMessagesAreRussianAndHonest() {
        let now = Date(timeIntervalSince1970: 1_000)
        let failures: [AccountFailure] = [
            .offline, .mailNotConfigured, .throttled(until: now.addingTimeInterval(10)),
            .invalidInput(""), .conflict(""), .wrongCode(""), .codeExpired, .tooManyCodeAttempts,
            .wrongPassword, .unavailable,
        ]
        for item in failures {
            let text = item.message(at: now) ?? ""
            XCTAssertTrue(text.unicodeScalars.contains { (0x0400...0x04FF).contains($0.value) }, "\(item): \(text)")
        }
        XCTAssertTrue(AccountFailure.mailNotConfigured.message(at: now)?.contains("почта не настроена") == true)
        XCTAssertNil(AccountFailure.throttled(until: now).message(at: now.addingTimeInterval(1)), "A finished wait shows nothing")
    }

    func testServerMessagesAreCappedAndFlattened() {
        let long = String(repeating: "очень ", count: 100)
        let cleaned = AccountFailure.clean("  первая\n\nстрока  " + long)
        XCTAssertLessThanOrEqual(cleaned.count, AccountFailure.messageLimit)
        XCTAssertFalse(cleaned.contains("\n"))
        XCTAssertTrue(cleaned.hasPrefix("первая строка"))
    }

    func testSupportContactBuildsOnlySafeLinks() {
        XCTAssertEqual(SupportContact.url(from: "help@company.kz")?.absoluteString, "mailto:help@company.kz")
        XCTAssertEqual(SupportContact.url(from: " https://company.kz/help ")?.absoluteString, "https://company.kz/help")
        XCTAssertNil(SupportContact.url(from: nil))
        XCTAssertNil(SupportContact.url(from: ""))
        XCTAssertNil(SupportContact.url(from: "javascript:alert(1)"))
        XCTAssertNil(SupportContact.url(from: "http://company.kz"))
        XCTAssertNil(SupportContact.url(from: "tel:+77001234567"))
        XCTAssertNil(SupportContact.url(from: "not an address"))
    }
}
