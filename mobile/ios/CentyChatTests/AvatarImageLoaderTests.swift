import Foundation
import XCTest
@testable import CentyChat

/// The avatar image loader against a stub server (`AvatarStubURLProtocol`): the Bearer token
/// only to the configured server, memory and disk cache keyed by URL, revalidation with
/// `ETag` / `If-None-Match` (`openapi.yaml` `/users/{id}/avatar`), and the wipe on sign-out.
final class AvatarImageLoaderTests: XCTestCase {
    private let avatarURL = URL(string: "https://chat.example.com/api/users/42/avatar?v=3f2a&size=s")!
    private let photo = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x01, 0x02, 0x03])
    private let newPhoto = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x09, 0x08, 0x07])
    private let clock = Locked(Date(timeIntervalSince1970: 1_000_000))
    private var directory: URL!

    override func setUp() {
        super.setUp()
        AvatarStubURLProtocol.reset()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("avatar-tests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        AvatarStubURLProtocol.reset()
        super.tearDown()
    }

    private func makeLoader(token: String? = "token-1") -> AvatarImageLoader {
        let clock = self.clock
        return AvatarImageLoader(
            serverURL: ServerEnvironment.test.serverURL,
            session: AvatarStubURLProtocol.session(),
            token: { token },
            directory: directory,
            now: { clock.value }
        )
    }

    private func jpeg(_ body: Data, etag: String = "\"avatar-v1-3f2a-s\"", maxAge: Int = 86_400) -> AvatarStubURLProtocol.Reply {
        .init(status: 200, headers: [
            "Content-Type": "image/jpeg",
            "ETag": etag,
            "Cache-Control": "private, max-age=\(maxAge)",
        ], body: body)
    }

    private func advance(_ seconds: TimeInterval) {
        clock.withValue { $0 = $0.addingTimeInterval(seconds) }
    }

    // MARK: - Authorization

    func testOwnServerAvatarIsRequestedWithTheBearerToken() async throws {
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(photo))
        let loader = makeLoader()

        let data = await loader.data(for: avatarURL)

        XCTAssertEqual(data, photo)
        let request = try XCTUnwrap(AvatarStubURLProtocol.requests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
        XCTAssertNil(request.value(forHTTPHeaderField: "If-None-Match"), "Nothing cached yet")
    }

    /// No request to a third-party host at all: it would learn the device's address (initials instead).
    func testAnotherHostIsNeverRequested() async {
        let foreign = URL(string: "https://cdn.example.org/photo.jpg")!
        AvatarStubURLProtocol.enqueue(foreign, jpeg(photo))

        let data = await makeLoader().data(for: foreign)

        XCTAssertNil(data)
        XCTAssertTrue(AvatarStubURLProtocol.requests.isEmpty)
    }

    /// The token goes only to the avatar path of the configured server, not to any URL there.
    func testAnotherPathOnTheServerIsNeverRequested() async {
        let download = URL(string: "https://chat.example.com/api/files/download/1")!
        AvatarStubURLProtocol.enqueue(download, jpeg(photo))

        let data = await makeLoader().data(for: download)

        XCTAssertNil(data)
        XCTAssertTrue(AvatarStubURLProtocol.requests.isEmpty)
    }

    /// A redirect would carry the Bearer token to another host: it is not followed.
    func testTheTokenNeverFollowsARedirect() async throws {
        let elsewhere = URL(string: "https://cdn.example.org/stolen.jpg")!
        AvatarStubURLProtocol.enqueue(avatarURL, .init(status: 302, headers: ["Location": elsewhere.absoluteString], redirectTo: elsewhere))
        AvatarStubURLProtocol.enqueue(elsewhere, jpeg(photo))

        let data = await makeLoader().data(for: avatarURL)

        XCTAssertNil(data, "No photo from a redirect")
        XCTAssertEqual(AvatarStubURLProtocol.requests.map(\.url), [avatarURL], "No second request to the redirect target")
    }

    func testAPlainHTTPAddressIsNeverRequested() async {
        let insecure = URL(string: "http://chat.example.com/api/users/42/avatar")!
        let data = await makeLoader().data(for: insecure)

        XCTAssertNil(data)
        XCTAssertTrue(AvatarStubURLProtocol.requests.isEmpty, "The token must never travel over plain HTTP")
    }

    // MARK: - Cache

    func testAFreshAvatarComesFromMemoryWithoutARequest() async {
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(photo))
        let loader = makeLoader()
        _ = await loader.data(for: avatarURL)
        advance(60)

        let again = await loader.data(for: avatarURL)

        XCTAssertEqual(again, photo)
        XCTAssertEqual(AvatarStubURLProtocol.requests.count, 1)
    }

    func testTheDiskCacheSurvivesTheProcessAndIsExcludedFromBackup() async throws {
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(photo))
        _ = await makeLoader().data(for: avatarURL)

        let relaunched = makeLoader()
        let data = await relaunched.data(for: avatarURL)

        XCTAssertEqual(data, photo)
        XCTAssertEqual(AvatarStubURLProtocol.requests.count, 1, "A fresh disk entry needs no request")
        let values = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
    }

    func testAStaleAvatarIsRevalidatedWithItsETagAndKeptOn304() async throws {
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(photo, maxAge: 600))
        AvatarStubURLProtocol.enqueue(avatarURL, .init(status: 304))
        let loader = makeLoader()
        _ = await loader.data(for: avatarURL)
        advance(601)

        let data = await loader.data(for: avatarURL)

        XCTAssertEqual(data, photo)
        XCTAssertEqual(AvatarStubURLProtocol.requests.count, 2)
        let revalidation = try XCTUnwrap(AvatarStubURLProtocol.requests.last)
        XCTAssertEqual(revalidation.value(forHTTPHeaderField: "If-None-Match"), "\"avatar-v1-3f2a-s\"")
        XCTAssertEqual(revalidation.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")

        // 304 renews the entry: the next look within max-age needs no request.
        advance(300)
        let renewed = await loader.data(for: avatarURL)
        XCTAssertEqual(renewed, photo)
        XCTAssertEqual(AvatarStubURLProtocol.requests.count, 2)
    }

    func testAChangedAvatarReplacesTheCachedOne() async {
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(photo, maxAge: 600))
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(newPhoto, etag: "\"avatar-v2\""))
        let loader = makeLoader()
        _ = await loader.data(for: avatarURL)
        advance(601)

        let data = await loader.data(for: avatarURL)

        XCTAssertEqual(data, newPhoto)
        let cached = await makeLoader().cachedData(for: avatarURL)
        XCTAssertEqual(cached, newPhoto, "The disk copy is replaced too")
    }

    func testARemovedAvatarIsDropped() async {
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(photo, maxAge: 600))
        AvatarStubURLProtocol.enqueue(avatarURL, .init(status: 404, headers: ["Content-Type": "application/json"],
                                                       body: Data(#"{"code":"NO_AVATAR"}"#.utf8)))
        let loader = makeLoader()
        _ = await loader.data(for: avatarURL)
        advance(601)

        let data = await loader.data(for: avatarURL)

        XCTAssertNil(data, "No photo any more: initials")
        let cached = await loader.cachedData(for: avatarURL)
        XCTAssertNil(cached)
    }

    func testOfflineKeepsShowingTheStaleAvatar() async {
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(photo, maxAge: 600))
        let loader = makeLoader()
        _ = await loader.data(for: avatarURL)
        advance(601)

        // Nothing queued: the request fails as if offline.
        let data = await loader.data(for: avatarURL)

        XCTAssertEqual(data, photo)
        XCTAssertEqual(AvatarStubURLProtocol.requests.count, 2)
    }

    func testANonImageAnswerIsNotCached() async {
        AvatarStubURLProtocol.enqueue(avatarURL, .init(status: 200, headers: ["Content-Type": "text/html"], body: Data("<html>".utf8)))
        let loader = makeLoader()

        let data = await loader.data(for: avatarURL)

        XCTAssertNil(data)
        let cached = await loader.cachedData(for: avatarURL)
        XCTAssertNil(cached)
    }

    // MARK: - Wipe

    func testRemoveAllWipesMemoryAndDisk() async {
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(photo))
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(newPhoto))
        let loader = makeLoader()
        _ = await loader.data(for: avatarURL)

        await loader.removeAll()

        let memory = await loader.cachedData(for: avatarURL)
        XCTAssertNil(memory)
        let disk = await makeLoader().cachedData(for: avatarURL)
        XCTAssertNil(disk)
        let reloaded = await loader.data(for: avatarURL)
        XCTAssertEqual(reloaded, newPhoto, "After the wipe the photo is fetched again")
        XCTAssertEqual(AvatarStubURLProtocol.requests.count, 2)
    }

    @MainActor
    func testSigningOutWipesTheAvatarCache() async throws {
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(photo))
        let loader = makeLoader()
        let app = TestApp(avatarLoader: loader)
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")
        _ = await loader.data(for: avatarURL)

        await app.session.logout()

        // Wiped by the time logout returns: a new sign-in can never interleave with the wipe.
        let memory = await loader.cachedData(for: avatarURL)
        XCTAssertNil(memory, "Sign-out must wipe the cached photos")
        let disk = await makeLoader().cachedData(for: avatarURL)
        XCTAssertNil(disk)
    }

    /// A session that ends at launch (stored token rejected, no device secret) is a sign-out too:
    /// the previous user's photos, directory and search recents must not stay behind.
    @MainActor
    func testASessionRejectedAtLaunchWipesTheSessionCaches() async throws {
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(photo))
        let loader = makeLoader()
        _ = await loader.data(for: avatarURL)
        let app = TestApp(avatarLoader: loader)
        app.auth.state.withValue {
            $0.hasToken = true
            $0.currentUserResult = .failure(APIError.unauthorized)
            $0.knockStatus = .loginRequired
        }
        app.peopleCache.value = CachedPeople(ownerId: 1, savedAt: Date(), people: [], tree: nil, selfPerson: nil)
        app.container.searchRecents.add(RecentItem(kind: .person, targetId: 8, title: "Боб Тестов"))

        await app.session.bootstrap()

        XCTAssertEqual(app.session.phase, .signedOut)
        let memory = await loader.cachedData(for: avatarURL)
        XCTAssertNil(memory, "The previous user's photos must be wiped")
        let disk = await makeLoader().cachedData(for: avatarURL)
        XCTAssertNil(disk)
        XCTAssertNil(app.peopleCache.value, "The previous user's directory must be wiped")
        XCTAssertEqual(app.container.searchRecents.items, [])
    }

    @MainActor
    func testDeletingTheAccountWipesTheAvatarCache() async throws {
        AvatarStubURLProtocol.enqueue(avatarURL, jpeg(photo))
        let loader = makeLoader()
        let app = TestApp(avatarLoader: loader)
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")
        _ = await loader.data(for: avatarURL)

        await app.session.finishAccountDeletion()

        let memory = await loader.cachedData(for: avatarURL)
        XCTAssertNil(memory, "Account deletion must wipe the cached photos")
    }
}
