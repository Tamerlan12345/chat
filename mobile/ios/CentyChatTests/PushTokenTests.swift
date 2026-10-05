import Foundation
import XCTest
@testable import CentyChat

/// Push-token registration (`push.md` §2, `openapi.yaml` `/devices/push-token`): the request
/// shapes against the stub server, and when the app registers and removes its APNs token.
final class PushTokenAPITests: XCTestCase {
    private func makeClient(routes: [String: RecordingURLProtocol.StubResponse]) -> APIClient {
        let store = SeededKeychainItemStore()
        store.seed("auth_token", "token-1")
        RecordingURLProtocol.reset(routes: routes)
        return APIClient(session: RecordingURLProtocol.session(), keychain: KeychainManager(testStore: store), environment: .test)
    }

    private func body(of request: RecordingURLProtocol.RecordedRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.body, "The request has no body")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testRegistrationSendsTheContractBodyWithTheSession() async throws {
        let client = makeClient(routes: [
            "/api/devices/push-token": .init(status: 200, body: #"{"registered":true,"push_enabled":false}"#),
        ])
        let registration = PushTokenRegistration(
            token: "ab01ff",
            environment: .sandbox,
            kind: .alert,
            appVersion: "1.0.0",
            deviceId: "3F2A-DEVICE"
        )

        let response = try await client.registerPushToken(registration)

        XCTAssertEqual(response, PushTokenRegisterResponse(registered: true, pushEnabled: false))
        let request = try XCTUnwrap(RecordingURLProtocol.requests.last)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url?.path, "/api/devices/push-token")
        XCTAssertEqual(request.headers["Authorization"], "Bearer token-1")
        let sent = try body(of: request)
        XCTAssertEqual(sent["platform"] as? String, "ios")
        XCTAssertEqual(sent["token"] as? String, "ab01ff")
        XCTAssertEqual(sent["environment"] as? String, "sandbox")
        XCTAssertEqual(sent["kind"] as? String, "alert")
        XCTAssertEqual(sent["app_version"] as? String, "1.0.0")
        XCTAssertEqual(sent["device_id"] as? String, "3F2A-DEVICE")
        XCTAssertEqual(Set(sent.keys), ["platform", "token", "environment", "kind", "app_version", "device_id"])
    }

    func testRegistrationLeavesOutUnknownOptionalFields() async throws {
        let client = makeClient(routes: [
            "/api/devices/push-token": .init(status: 200, body: #"{"registered":true,"push_enabled":true}"#),
        ])

        _ = try await client.registerPushToken(PushTokenRegistration(
            token: "ab01ff", environment: .production, kind: .voip, appVersion: nil, deviceId: nil
        ))

        let sent = try body(of: try XCTUnwrap(RecordingURLProtocol.requests.last))
        XCTAssertEqual(sent["environment"] as? String, "production")
        XCTAssertEqual(sent["kind"] as? String, "voip")
        XCTAssertNil(sent["app_version"])
        XCTAssertNil(sent["device_id"])
    }

    func testRemovalSendsTheTokenAndReadsTheAnswer() async throws {
        let client = makeClient(routes: [
            "/api/devices/push-token": .init(status: 200, body: #"{"removed":true}"#),
        ])

        let removed = try await client.unregisterPushToken("ab01ff")

        XCTAssertTrue(removed)
        let request = try XCTUnwrap(RecordingURLProtocol.requests.last)
        XCTAssertEqual(request.method, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/devices/push-token")
        XCTAssertEqual(request.headers["Authorization"], "Bearer token-1")
        XCTAssertEqual(try body(of: request) as NSDictionary, ["token": "ab01ff"] as NSDictionary)
    }

    func testARejectedTokenSurfacesTheServerCode() async {
        let client = makeClient(routes: [
            "/api/devices/push-token": .init(status: 400, body: #"{"error":"Недопустимый токен устройства","code":"INVALID_TOKEN"}"#),
        ])
        do {
            _ = try await client.registerPushToken(PushTokenRegistration(
                token: "zz", environment: .sandbox, kind: .alert, appVersion: nil, deviceId: nil
            ))
            XCTFail("400 must fail")
        } catch APIError.httpError(let status, _, let code, _) {
            XCTAssertEqual(status, 400)
            XCTAssertEqual(code, "INVALID_TOKEN")
        } catch {
            XCTFail("Unexpected \(error)")
        }
    }

    func testDeviceTokenIsSentAsLowercaseHex() {
        XCTAssertEqual(PushTokenRegistrar.hex(Data([0xAB, 0x01, 0xFF, 0x00])), "ab01ff00")
    }

    func testDebugBuildsRegisterForTheSandbox() {
#if DEBUG
        XCTAssertEqual(PushTokenRegistration.Environment.current, .sandbox, "Xcode builds get sandbox APNs tokens")
#else
        XCTAssertEqual(PushTokenRegistration.Environment.current, .production)
#endif
    }
}

/// When the token reaches the server: after every sign-in and launch with a live session, on
/// every new token, and not after sign-out (`push.md` §2).
@MainActor
final class PushTokenRegistrarTests: XCTestCase {
    private let apnsToken = Data([0xAB, 0xCD, 0x01, 0x02])

    private func makeRegistrar(_ service: FakePushTokenService) -> PushTokenRegistrar {
        PushTokenRegistrar(service: service, deviceId: { "DEVICE-1" }, appVersion: "1.0.0", environment: .sandbox)
    }

    func testATokenWithoutASessionWaitsForTheSignIn() async {
        let service = FakePushTokenService()
        let registrar = makeRegistrar(service)

        await registrar.deviceTokenChanged(apnsToken)
        XCTAssertTrue(service.registrations.isEmpty, "Registration needs a session")

        await registrar.sessionDidAuthenticate()

        XCTAssertEqual(service.registrations, [PushTokenRegistration(
            token: "abcd0102", environment: .sandbox, kind: .alert, appVersion: "1.0.0", deviceId: "DEVICE-1"
        )])
    }

    func testATokenArrivingDuringTheSessionIsRegisteredAndANewOneReplacesIt() async {
        let service = FakePushTokenService()
        let registrar = makeRegistrar(service)
        await registrar.sessionDidAuthenticate()
        XCTAssertTrue(service.registrations.isEmpty, "No token yet")

        await registrar.deviceTokenChanged(apnsToken)
        await registrar.deviceTokenChanged(apnsToken)
        await registrar.deviceTokenChanged(Data([0x01]))

        XCTAssertEqual(service.registrations.map(\.token), ["abcd0102", "01"], "The same token is not sent twice")
    }

    func testSignOutRemovesTheTokenAndStopsRegistering() async {
        let service = FakePushTokenService()
        let registrar = makeRegistrar(service)
        await registrar.deviceTokenChanged(apnsToken)
        await registrar.sessionDidAuthenticate()

        await registrar.sessionWillSignOut()
        registrar.sessionDidEnd()
        await registrar.deviceTokenChanged(Data([0x02]))

        XCTAssertEqual(service.removals, ["abcd0102"])
        XCTAssertEqual(service.registrations.count, 1, "No registration after sign-out")
    }

    func testAFailedRegistrationIsRetriedAtTheNextSignIn() async {
        let service = FakePushTokenService()
        service.failure = APIError.noConnection
        let registrar = makeRegistrar(service)
        await registrar.deviceTokenChanged(apnsToken)
        await registrar.sessionDidAuthenticate()
        registrar.sessionDidEnd()

        service.failure = nil
        await registrar.sessionDidAuthenticate()

        XCTAssertEqual(service.registrations.map(\.token), ["abcd0102"])
        XCTAssertEqual(service.attempts, 2)
    }

    // MARK: - Session wiring

    func testSignInRegistersAndSignOutRemovesTheToken() async throws {
        let service = FakePushTokenService()
        let app = TestApp(pushTokens: service)
        service.auth = app.auth
        await app.container.pushTokens.deviceTokenChanged(apnsToken)
        await app.session.bootstrap()
        XCTAssertTrue(service.registrations.isEmpty, "Signed out: nothing is registered")

        _ = try await app.session.login(username: "qa", password: "password")
        XCTAssertEqual(service.registrations.map(\.token), ["abcd0102"])

        await app.session.logout()
        XCTAssertEqual(service.removals, ["abcd0102"])
        XCTAssertEqual(service.removalsBeforeLogout, 1, "Removed while the session is still valid")
        XCTAssertEqual(app.auth.state.value.logoutCount, 1)
    }

    func testALaunchWithALiveSessionRegistersAgain() async {
        let service = FakePushTokenService()
        let app = TestApp(pushTokens: service)
        app.auth.state.withValue { $0.hasToken = true }
        await app.container.pushTokens.deviceTokenChanged(apnsToken)

        await app.session.bootstrap()

        XCTAssertEqual(app.session.phase, .authenticated)
        XCTAssertEqual(service.registrations.map(\.token), ["abcd0102"])
    }
}

/// Records registrations; `removalsBeforeLogout` counts removals made while `auth` still had a session.
final class FakePushTokenService: PushTokenService, @unchecked Sendable {
    private let state = Locked<(registrations: [PushTokenRegistration], removals: [String], attempts: Int, failure: (any Error)?)>(([], [], 0, nil))
    /// The auth fake of the app under test, to see whether the session was still there.
    var auth: FakeAuthRepository?
    private let removedWithSession = Locked(0)

    var registrations: [PushTokenRegistration] { state.value.registrations }
    var removals: [String] { state.value.removals }
    var attempts: Int { state.value.attempts }
    var removalsBeforeLogout: Int { removedWithSession.value }
    var failure: (any Error)? {
        get { state.value.failure }
        set { state.withValue { $0.failure = newValue } }
    }

    func register(_ registration: PushTokenRegistration) async throws -> PushTokenRegisterResponse {
        try state.withValue { state in
            state.attempts += 1
            if let failure = state.failure { throw failure }
            state.registrations.append(registration)
        }
        return PushTokenRegisterResponse(registered: true, pushEnabled: false)
    }

    func unregister(token: String) async throws -> Bool {
        if auth?.hasStoredToken == true {
            removedWithSession.withValue { $0 += 1 }
        }
        state.withValue { $0.removals.append(token) }
        return true
    }
}
