import Foundation
import XCTest
@testable import CentyChat

/// Avatars as links (server task 20, `openapi.yaml` `User.avatar_url`, `ws-protocol.md`): the
/// opt-in on every request and on the socket, which URLs are loaded at which size, and the
/// fallback colour and initials shared with the desktop client (`desktop/.../lib/avatar.mjs`).
final class AvatarTests: XCTestCase {
    // MARK: - Fallback colour and initials (ledger ruling 2026-10-02: the desktop name hash)

    /// Expected values produced by the desktop `avatarColor` / `initialsOf` (node).
    func testFallbackColourIsTheDesktopNameHash() {
        let vectors: [(String, UInt32)] = [
            ("Алиса Тестова", 0x475569),
            ("Боб Тестов", 0x0E7490),
            ("Данияр Ахметов", 0x7C3AED),
            ("Новый Сотрудник", 0xB45309),
            ("Сотрудник Тестовый", 0xBE185D),
            ("Мария", 0x4338CA),
            ("Ли Мин 🙂", 0x2563EB),
            ("", 0x2563EB),
        ]
        for (name, expected) in vectors {
            XCTAssertEqual(AvatarPalette.colorHex(for: name), expected, "Colour of «\(name)»")
        }
    }

    func testFallbackColourIsStableAcrossCalls() {
        // String.hashValue is seeded per process; the palette must not depend on it.
        XCTAssertEqual(AvatarPalette.colorHex(for: "Боб Тестов"), AvatarPalette.colorHex(for: "Боб Тестов"))
    }

    func testInitialsFollowTheDesktop() {
        XCTAssertEqual(AvatarPalette.initials(of: "Алиса Тестова"), "АТ")
        XCTAssertEqual(AvatarPalette.initials(of: "Иванов Иван Иванович"), "ИИ")
        XCTAssertEqual(AvatarPalette.initials(of: "Администратор системы"), "А", "A lowercase second word is not a name")
        XCTAssertEqual(AvatarPalette.initials(of: "qa"), "Q")
        XCTAssertEqual(AvatarPalette.initials(of: "  "), "?")
        XCTAssertEqual(AvatarPalette.initials(of: ""), "?")
    }

    // MARK: - Which URL is loaded

    private let server = ServerEnvironment.test.serverURL

    func testOwnAvatarPathResolvesAgainstTheServerWithTheSizeForTheDiameter() {
        XCTAssertEqual(
            AvatarImageLoader.resolve("/api/users/42/avatar?v=3f2a", serverURL: server, diameter: 40)?.absoluteString,
            "https://chat.example.com/api/users/42/avatar?v=3f2a&size=s",
            "Up to 48 pt the 96 px picture is enough"
        )
        XCTAssertEqual(
            AvatarImageLoader.resolve("/api/users/42/avatar?v=3f2a", serverURL: server, diameter: 96)?.absoluteString,
            "https://chat.example.com/api/users/42/avatar?v=3f2a&size=m"
        )
        XCTAssertEqual(
            AvatarImageLoader.resolve("https://chat.example.com/api/users/7/avatar?size=m&v=1", serverURL: server, diameter: 40)?.absoluteString,
            "https://chat.example.com/api/users/7/avatar?v=1&size=s",
            "An existing size is replaced, not duplicated"
        )
    }

    func testOnlyHTTPSImagesAreLoaded() {
        XCTAssertEqual(
            AvatarImageLoader.resolve("https://cdn.example.org/photo.jpg", serverURL: server, diameter: 40)?.absoluteString,
            "https://cdn.example.org/photo.jpg",
            "Another host keeps its URL (and never gets the token)"
        )
        XCTAssertNil(AvatarImageLoader.resolve("http://chat.example.com/api/users/1/avatar", serverURL: server, diameter: 40))
        XCTAssertNil(AvatarImageLoader.resolve("//evil.example.org/x.jpg", serverURL: server, diameter: 40))
        XCTAssertNil(AvatarImageLoader.resolve("data:image/png;base64,AAAA", serverURL: server, diameter: 40))
        XCTAssertNil(AvatarImageLoader.resolve("javascript:alert(1)", serverURL: server, diameter: 40))
        XCTAssertNil(AvatarImageLoader.resolve("", serverURL: server, diameter: 40))
        XCTAssertNil(AvatarImageLoader.resolve(nil, serverURL: server, diameter: 40))
    }

    // MARK: - Opt-in

    func testEveryAPIRequestAsksForAvatarLinks() async throws {
        RecordingURLProtocol.reset(routes: RecordingURLProtocol.defaultRoutes.merging([
            "/api/users": .init(status: 200, body: "[]"),
        ]) { _, new in new })
        let store = SeededKeychainItemStore()
        store.seed("auth_token", "token-1")
        let client = APIClient(session: RecordingURLProtocol.session(), keychain: KeychainManager(testStore: store), environment: .test)

        _ = try await client.getUsers()
        _ = try await client.checkHealth()

        let requests = RecordingURLProtocol.requests
        XCTAssertEqual(requests.count, 2)
        for request in requests {
            XCTAssertEqual(request.headers["X-Avatar-Format"], "url", "\(request.url?.path ?? "")")
        }
    }

    func testTheSocketAsksForAvatarLinks() throws {
        let url = try XCTUnwrap(ServerEndpointPolicy.webSocketURL(for: ServerEnvironment.test.serverURL))
        XCTAssertEqual(url.absoluteString, "wss://chat.example.com/ws?avatars=url")
    }
}
