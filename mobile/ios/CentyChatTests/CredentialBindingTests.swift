import Foundation
import Security
import XCTest
@testable import CentyChat

/// Stored credentials are only used with the server that issued them. Older installs kept a
/// user-entered server URL; it is never used again, and a session or device secret issued by
/// another host is wiped.
final class CredentialBindingTests: XCTestCase {
    private let production = ServerEnvironment.production.origin

    func testLegacyServerURLForAnotherHostWipesTheSession() throws {
        let store = SeededKeychainItemStore()
        store.seed("server_url", "https://chat.old-company.kz")
        store.seed("auth_token", "foreign-token")
        store.seed("device_secret", "foreign-secret")
        store.seed("device_id", "device-1")
        store.seed("saved_username", "alice")
        let keychain = KeychainManager(testStore: store)

        let decision = try keychain.bindCredentials(toOrigin: production)

        XCTAssertEqual(decision, .wiped)
        XCTAssertNil(keychain.authToken)
        XCTAssertNil(keychain.deviceSecret)
        XCTAssertNil(store.string("server_url"), "The stale server URL must not survive the migration")
        XCTAssertEqual(store.string("credential_origin"), production)
        XCTAssertEqual(try keychain.deviceID(), "device-1", "The device identifier is not a credential")
        XCTAssertEqual(keychain.savedUsername, "alice", "The last login name is kept for convenience")
    }

    func testLegacyServerURLForThisHostKeepsTheSession() throws {
        let store = SeededKeychainItemStore()
        store.seed("server_url", "https://centychat-production.up.railway.app/")
        store.seed("auth_token", "token")
        store.seed("device_secret", "secret")
        let keychain = KeychainManager(testStore: store)

        let decision = try keychain.bindCredentials(toOrigin: production)

        XCTAssertEqual(decision, .kept)
        XCTAssertEqual(keychain.authToken, "token")
        XCTAssertEqual(keychain.deviceSecret, "secret")
        XCTAssertNil(store.string("server_url"))
        XCTAssertEqual(store.string("credential_origin"), production)
    }

    func testInsecureLegacyServerURLDoesNotVouchForTheSession() throws {
        let store = SeededKeychainItemStore()
        store.seed("server_url", "http://centychat-production.up.railway.app")
        store.seed("auth_token", "token")
        let keychain = KeychainManager(testStore: store)

        XCTAssertEqual(try keychain.bindCredentials(toOrigin: production), .wiped)
        XCTAssertNil(keychain.authToken)
    }

    func testCredentialsWithUnknownIssuerAreWiped() throws {
        let store = SeededKeychainItemStore()
        store.seed("auth_token", "token")
        let keychain = KeychainManager(testStore: store)

        XCTAssertEqual(try keychain.bindCredentials(toOrigin: production), .wiped)
        XCTAssertNil(keychain.authToken)
    }

    func testCredentialsIssuedByThisServerAreKeptAcrossLaunches() throws {
        let keychain = KeychainManager(testStore: SeededKeychainItemStore())
        XCTAssertEqual(try keychain.bindCredentials(toOrigin: production), .nothingStored)
        try keychain.saveAuthToken("token")

        XCTAssertEqual(try keychain.bindCredentials(toOrigin: production), .kept)
        XCTAssertEqual(keychain.authToken, "token")
    }

    func testCredentialsFromAnotherDebugServerAreWiped() throws {
        let keychain = KeychainManager(testStore: SeededKeychainItemStore())
        _ = try keychain.bindCredentials(toOrigin: "https://localhost:8443")
        try keychain.saveAuthToken("stand-token")
        try keychain.saveDeviceSecret("stand-secret")

        XCTAssertEqual(try keychain.bindCredentials(toOrigin: production), .wiped)
        XCTAssertNil(keychain.authToken)
        XCTAssertNil(keychain.deviceSecret)
    }

    func testFailedWipeIsReportedInsteadOfKeepingTheForeignSession() {
        let store = SeededKeychainItemStore(failingDeletes: ["auth_token": errSecInteractionNotAllowed])
        store.seed("server_url", "https://chat.old-company.kz")
        store.seed("auth_token", "foreign-token")
        let keychain = KeychainManager(testStore: store)

        XCTAssertThrowsError(try keychain.bindCredentials(toOrigin: production))
        XCTAssertNotEqual(store.string("credential_origin"), production, "A failed wipe must not bless the foreign token")
    }
}

/// End to end over the live repositories: an install that used to point at another server
/// lands on login, and its old credentials never reach the network.
@MainActor
final class LegacyInstallMigrationTests: XCTestCase {
    func testForeignSessionIsWipedAndNeverSent() async throws {
        let store = SeededKeychainItemStore()
        store.seed("server_url", "https://chat.old-company.kz")
        store.seed("auth_token", "foreign-token")
        store.seed("device_secret", "foreign-secret")
        let keychain = KeychainManager(testStore: store)
        RecordingURLProtocol.reset()
        let client = APIClient(session: RecordingURLProtocol.session(), keychain: keychain, environment: .test)
        let session = SessionStore(
            auth: LiveAuthRepository(client: client, keychain: keychain),
            server: LiveServerRepository(client: client),
            realtime: RealtimeStore(repository: FakeRealtimeRepository()),
            environment: .test,
            deviceDescriptor: { DeviceDescriptor(name: "Test iPhone", platform: "iOS 17") }
        )

        await session.bootstrap()

        XCTAssertEqual(session.phase, .signedOut)
        XCTAssertNil(keychain.authToken)
        XCTAssertNil(keychain.deviceSecret)
        XCTAssertNil(store.string("server_url"))
        let requests = RecordingURLProtocol.requests
        XCTAssertFalse(requests.isEmpty)
        XCTAssertEqual(Set(requests.compactMap { $0.url?.host }), ["chat.example.com"], "Only the fixed server may be contacted")
        for request in requests {
            XCTAssertNil(request.headers["Authorization"], "The foreign token must never be sent: \(request.url?.path ?? "")")
            let body = request.body.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            XCTAssertFalse(body.contains("foreign-secret"), "The foreign device secret must never be sent")
        }
    }

    func testCompanyNameComesFromTheServer() async {
        let keychain = KeychainManager(testStore: SeededKeychainItemStore())
        RecordingURLProtocol.reset()
        let client = APIClient(session: RecordingURLProtocol.session(), keychain: keychain, environment: .test)
        let session = SessionStore(
            auth: LiveAuthRepository(client: client, keychain: keychain),
            server: LiveServerRepository(client: client),
            realtime: RealtimeStore(repository: FakeRealtimeRepository()),
            environment: .test,
            deviceDescriptor: { DeviceDescriptor(name: "Test iPhone", platform: "iOS 17") }
        )

        await session.bootstrap()

        XCTAssertEqual(session.companyName, "ТОО «Тестовая компания»")
    }
}
