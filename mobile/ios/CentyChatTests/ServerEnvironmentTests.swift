import Foundation
import XCTest
@testable import CentyChat

/// The server is fixed at build time: Release is a compile-time constant, Debug reads the
/// build configuration and (UI tests only) a launch argument.
final class ServerEnvironmentTests: XCTestCase {
    private let productionURL = "https://centychat-production.up.railway.app"
    private let attacker = "https://attacker.example"

    func testProductionIsTheRailwayServer() {
        let production = ServerEnvironment.production

        XCTAssertEqual(production.serverURL.absoluteString, productionURL)
        XCTAssertEqual(production.apiBaseURL.absoluteString, productionURL + "/api")
        XCTAssertEqual(production.webSocketURL.absoluteString, "wss://centychat-production.up.railway.app/ws")
        XCTAssertEqual(production.origin, productionURL)
    }

    func testReleaseResolvesExactlyProductionAndIgnoresEveryOverride() {
        let resolved = ServerEnvironment.resolve(
            .release,
            infoPlistValue: attacker,
            arguments: ["CentyChat", "-centychat-server-url", attacker],
            environment: ["CENTYCHAT_UI_TESTING": "1", "CENTYCHAT_SERVER_URL": attacker]
        )

        XCTAssertEqual(resolved, .production)
        XCTAssertEqual(resolved.serverURL.absoluteString, productionURL)
    }

    func testDebugDefaultsToProduction() {
        for value in [nil, "", "   ", "$(CENTYCHAT_SERVER_URL)"] {
            let resolved = ServerEnvironment.resolve(.debug, infoPlistValue: value, arguments: [], environment: [:])
            XCTAssertEqual(resolved, .production, "Info.plist value \(String(describing: value))")
        }
    }

    func testDebugUsesTheServerFromTheBuildConfiguration() {
        let resolved = ServerEnvironment.resolve(
            .debug,
            infoPlistValue: "https://localhost:8443",
            arguments: [],
            environment: [:]
        )

        XCTAssertEqual(resolved.serverURL.absoluteString, "https://localhost:8443")
        XCTAssertEqual(resolved.apiBaseURL.absoluteString, "https://localhost:8443/api")
        XCTAssertEqual(resolved.webSocketURL.absoluteString, "wss://localhost:8443/ws")
        XCTAssertEqual(resolved.origin, "https://localhost:8443")
    }

    func testDebugRejectsInsecureOrMalformedConfiguration() {
        let rejected = [
            "http://localhost:8443",
            "ws://localhost:8443",
            "ftp://files.example",
            "https://user:secret@chat.example.com",
            "https://chat.example.com/base",
            "https://chat.example.com?server=evil",
            "not a url",
        ]
        for value in rejected {
            let resolved = ServerEnvironment.resolve(.debug, infoPlistValue: value, arguments: [], environment: [:])
            XCTAssertEqual(resolved, .production, "\(value) must not be accepted")
        }
    }

    func testLaunchArgumentIsHonouredOnlyForUITests() {
        let arguments = ["CentyChat", "-centychat-server-url", "https://localhost:8443"]

        let plainLaunch = ServerEnvironment.resolve(.debug, infoPlistValue: nil, arguments: arguments, environment: [:])
        XCTAssertEqual(plainLaunch, .production, "A launch argument alone must not change the server")

        let uiTest = ServerEnvironment.resolve(
            .debug,
            infoPlistValue: nil,
            arguments: arguments,
            environment: ["CENTYCHAT_UI_TESTING": "1"]
        )
        XCTAssertEqual(uiTest.serverURL.absoluteString, "https://localhost:8443")
    }

    func testInsecureLaunchArgumentFallsBackToTheBuildConfiguration() {
        let resolved = ServerEnvironment.resolve(
            .debug,
            infoPlistValue: "https://localhost:8443",
            arguments: ["CentyChat", "-centychat-server-url", "http://localhost:8080"],
            environment: ["CENTYCHAT_UI_TESTING": "1"]
        )

        XCTAssertEqual(resolved.serverURL.absoluteString, "https://localhost:8443")
    }

    func testOriginIgnoresCaseTrailingSlashAndDefaultPort() {
        XCTAssertEqual(ServerEnvironment.origin(of: "HTTPS://CentyChat-Production.up.railway.app/"), productionURL)
        XCTAssertEqual(ServerEnvironment.origin(of: "https://centychat-production.up.railway.app:443"), productionURL)
        XCTAssertEqual(ServerEnvironment.origin(of: "https://localhost:8443/api"), "https://localhost:8443")
        XCTAssertNil(ServerEnvironment.origin(of: "garbage"))
    }

    func testAPIClientUsesTheEnvironmentAndIgnoresALegacyStoredURL() async throws {
        let store = SeededKeychainItemStore()
        store.seed("server_url", "https://chat.old-company.kz")
        let keychain = KeychainManager(testStore: store)
        RecordingURLProtocol.reset()
        let client = APIClient(session: RecordingURLProtocol.session(), keychain: keychain, environment: .test)

        let health = try await client.checkHealth()

        XCTAssertTrue(health.isHealthy)
        XCTAssertEqual(RecordingURLProtocol.requests.map { $0.url?.host }, ["chat.example.com"])
    }
}
