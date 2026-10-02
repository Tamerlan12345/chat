import Foundation
import Security
import XCTest
@testable import CentyChat

final class DTOParsingTests: XCTestCase {

    func testUserParsing() throws {
        let json = """
        {
            "id": 7,
            "username": "k.akhmetov",
            "full_name": "Ахметов Канат",
            "email": "k.akhmetov@cic.kz",
            "phone": "+7 (727) 250-00-11",
            "job_title": "Ведущий разработчик",
            "department_id": 3,
            "department_name": "Отдел мобильной разработки",
            "role_id": 2,
            "role_name": "Сотрудник",
            "permissions": {
                "is_admin": false,
                "can_call": true,
                "can_create_channels": true,
                "can_upload_files": true
            },
            "uin": 1042,
            "extension": "142",
            "company": "АО СК «Сентрас Иншуранс»",
            "status": "online",
            "custom_status": "Работа над iOS",
            "last_seen": "2026-09-30T09:15:22.000Z",
            "is_active": 1,
            "must_change_password": 0,
            "approval_status": "approved",
            "created_at": "2025-01-10T08:00:00.000Z"
        }
        """.data(using: .utf8)!

        let user = try JSONDecoder().decode(User.self, from: json)

        XCTAssertEqual(user.id, 7)
        XCTAssertEqual(user.username, "k.akhmetov")
        XCTAssertEqual(user.fullName, "Ахметов Канат")
        XCTAssertEqual(user.status, .online)
        XCTAssertTrue(user.isActive)
        XCTAssertFalse(user.mustChangePassword)
        XCTAssertEqual(user.permissions?.canCall, true)
        XCTAssertEqual(user.permissions?.canCreateChannels, true)
        XCTAssertEqual(user.uin, 1042)
    }

    func testChannelParsing() throws {
        let json = """
        {
            "id": 1,
            "name": "#Общий",
            "topic": "Главный канал компании",
            "type": "public",
            "owner_id": 1,
            "created_at": "2025-01-01T00:00:00.000Z",
            "member_role": "member",
            "members_count": 180,
            "unread_count": 5,
            "last_message_text": "Всем доброе утро!",
            "last_message_time": "2026-09-30T09:00:00.000Z"
        }
        """.data(using: .utf8)!

        let channel = try JSONDecoder().decode(Channel.self, from: json)

        XCTAssertEqual(channel.id, 1)
        XCTAssertEqual(channel.name, "#Общий")
        XCTAssertEqual(channel.type, .public)
        XCTAssertEqual(channel.membersCount, 180)
        XCTAssertEqual(channel.unreadCount, 5)
        XCTAssertEqual(channel.lastMessageText, "Всем доброе утро!")
    }

    func testMessageParsingWithMetadata() throws {
        let json = """
        {
            "id": 240,
            "conversation_type": "direct",
            "target_id": 12,
            "sender_id": 7,
            "text": "Привет! Отправил спецификацию",
            "type": "file",
            "reply_to_id": null,
            "metadata_json": "{\\"file_id\\": 42, \\"file_name\\": \\"spec.pdf\\", \\"size\\": 1048576}",
            "created_at": "2026-09-30T09:20:15.000Z",
            "updated_at": null,
            "is_deleted": 0,
            "sender_username": "k.akhmetov",
            "sender_name": "Ахметов Канат",
            "file_original_name": "spec.pdf",
            "delivery_status": "read"
        }
        """.data(using: .utf8)!

        let message = try JSONDecoder().decode(Message.self, from: json)

        XCTAssertEqual(message.id, 240)
        XCTAssertEqual(message.conversationType, .direct)
        XCTAssertEqual(message.targetId, 12)
        XCTAssertEqual(message.senderId, 7)
        XCTAssertEqual(message.type, .file)
        XCTAssertFalse(message.isDeleted)
        XCTAssertEqual(message.deliveryStatus, .read)
        XCTAssertEqual(message.metadata?.fileId, 42)
        XCTAssertEqual(message.metadata?.fileName, "spec.pdf")
        XCTAssertEqual(message.metadata?.fileSize, 1048576)
    }

    func testAnnouncementParsing() throws {
        let json = """
        {
            "id": 3,
            "author_id": 1,
            "title": "Плановые работы",
            "content": "Обновление серверной инфраструктуры",
            "target_type": "all",
            "priority": "urgent",
            "created_at": "2026-09-30T08:00:00.000Z",
            "author_name": "Главный Администратор",
            "confirmed_at": null,
            "is_confirmed": 0
        }
        """.data(using: .utf8)!

        let announcement = try JSONDecoder().decode(Announcement.self, from: json)

        XCTAssertEqual(announcement.id, 3)
        XCTAssertEqual(announcement.title, "Плановые работы")
        XCTAssertEqual(announcement.priority, .urgent)
        XCTAssertFalse(announcement.isConfirmed)
        XCTAssertNil(announcement.confirmedAt)
    }

    func testWebSocketEventParsing() throws {
        let rawWsJson = """
        {
            "type": "wake_ring",
            "fromUserId": 12,
            "fromName": "Данияр Нурпеисов",
            "at": 1759230000000
        }
        """.data(using: .utf8)!

        let event = WSServerEvent.parse(from: rawWsJson)

        guard case .wakeRing(let fromId, let fromName, let at) = event else {
            XCTFail("Failed to parse wake_ring event")
            return
        }

        XCTAssertEqual(fromId, 12)
        XCTAssertEqual(fromName, "Данияр Нурпеисов")
        XCTAssertEqual(at, 1759230000000)
    }
}

final class EndpointSecurityTests: XCTestCase {
    func testProductionEndpointPolicyRejectsMissingAndInsecureEndpoints() {
        XCTAssertNil(ServerEndpointPolicy.productionURL(from: ""))
        XCTAssertNil(ServerEndpointPolicy.productionURL(from: "http://chat.example.com"))
        XCTAssertNil(ServerEndpointPolicy.productionURL(from: "ws://chat.example.com"))
        XCTAssertNotNil(ServerEndpointPolicy.productionURL(from: "https://chat.example.com"))
    }

    func testWebSocketAndAuthorizationRequireSecureTransport() {
        let secureURL = try! XCTUnwrap(ServerEndpointPolicy.productionURL(from: "https://chat.example.com/base"))
        let webSocketURL = ServerEndpointPolicy.webSocketURL(for: secureURL)

        XCTAssertEqual(webSocketURL?.scheme, "wss")
        XCTAssertEqual(webSocketURL?.path, "/ws")
        XCTAssertTrue(ServerEndpointPolicy.allowsAuthorization(to: secureURL))
        XCTAssertFalse(ServerEndpointPolicy.allowsAuthorization(to: URL(string: "http://127.0.0.1:2004")!))
    }

#if DEBUG
    func testDebugFixturePermitsOnlyLoopbackHTTP() {
        XCTAssertNotNil(ServerEndpointPolicy.debugFixtureURL(from: "http://127.0.0.1:2004"))
        XCTAssertNotNil(ServerEndpointPolicy.debugFixtureURL(from: "http://localhost:2004"))
        XCTAssertNil(ServerEndpointPolicy.debugFixtureURL(from: "http://192.168.1.100:2004"))
    }
#endif

    func testRefreshCoordinatorSharesOneRefreshForSameExpiredToken() async throws {
        let counter = RefreshInvocationCounter()
        let secondCallerJoined = AsyncGate()
        let coordinator = TokenRefreshCoordinator {
            Task {
                await secondCallerJoined.open()
            }
        }
        let refreshStarted = AsyncGate()
        let allowRefreshToFinish = AsyncGate()

        let first = Task {
            try await coordinator.token(for: "expired-token") {
                await counter.increment()
                await refreshStarted.open()
                await allowRefreshToFinish.wait()
                return "fresh-token"
            }
        }
        await refreshStarted.wait()

        let second = Task {
            try await coordinator.token(for: "expired-token") {
                await counter.increment()
                return "unexpected-second-refresh"
            }
        }

        await secondCallerJoined.wait()
        await allowRefreshToFinish.open()
        let firstToken = try await first.value
        let secondToken = try await second.value
        let refreshInvocations = await counter.value
        XCTAssertEqual(firstToken, "fresh-token")
        XCTAssertEqual(secondToken, "fresh-token")
        XCTAssertEqual(refreshInvocations, 1)
    }
}

private actor RefreshInvocationCounter {
    private(set) var value = 0

    func increment() {
        value += 1
    }
}

private actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        guard !isOpen else { return }
        isOpen = true
        let pendingWaiters = waiters
        waiters.removeAll()
        pendingWaiters.forEach { $0.resume() }
    }
}

final class KeychainFailClosedTests: XCTestCase {
    func testFailedTokenSaveMakesLoginFailBeforeCallerCanAuthenticate() async throws {
        let store = InMemoryKeychainItemStore(failure: .add(account: "auth_token", status: errSecAuthFailed))
        let keychain = KeychainManager(testStore: store)
        try keychain.saveServerURL("https://chat.example.com")
        let client = APIClient(session: makeSession(), keychain: keychain)
        let session = await Self.makeSessionStore(client: client, keychain: keychain)

        do {
            _ = try await session.login(username: "qa", password: "password")
            XCTFail("Login must fail when its bearer token cannot be persisted securely.")
        } catch let error as KeychainManagerError {
            XCTAssertEqual(error, .addFailed(status: errSecAuthFailed))
        } catch {
            XCTFail("Expected a typed KeychainManagerError, got: \(error)")
        }

        XCTAssertNil(keychain.authToken)
        let isAuthenticated = await MainActor.run { session.isAuthenticated }
        XCTAssertFalse(isAuthenticated)
    }

    func testFailedTokenDeleteMakesLogoutFailAndPreservesAuthenticatedState() async throws {
        let store = InMemoryKeychainItemStore(failure: .delete(account: "auth_token", status: errSecAuthFailed))
        let keychain = KeychainManager(testStore: store)
        try keychain.saveServerURL("https://chat.example.com")
        try keychain.saveAuthToken("persisted-token")
        let client = APIClient(session: makeSession(), keychain: keychain)
        let session = await Self.makeSessionStore(client: client, keychain: keychain)
        await MainActor.run { session.isAuthenticated = true }

        await session.logout()

        XCTAssertEqual(keychain.authToken, "persisted-token")
        let state = await MainActor.run { (session.isAuthenticated, session.errorMessage) }
        XCTAssertTrue(state.0)
        XCTAssertEqual(state.1, KeychainManagerError.deleteFailed(status: errSecAuthFailed).localizedDescription)
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AuthResponseURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    @MainActor
    private static func makeSessionStore(client: APIClient, keychain: KeychainManager) -> SessionStore {
        SessionStore(
            auth: LiveAuthRepository(client: client, keychain: keychain),
            server: LiveServerRepository(client: client, keychain: keychain),
            realtime: RealtimeStore(repository: FakeRealtimeRepository()),
            deviceDescriptor: { DeviceDescriptor(name: "Test iPhone", platform: "iOS 17") }
        )
    }
}

private final class AuthResponseURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "chat.example.com"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: 200,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"]
              ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        let payload: String
        switch url.path {
        case "/api/auth/login":
            payload = """
            {"user":{"id":1,"username":"qa","full_name":"QA User","is_active":1,"must_change_password":0},"token":"server-token"}
            """
        case "/api/auth/logout":
            payload = "{\"success\":true}"
        default:
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }

        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class InMemoryKeychainItemStore: KeychainItemStore {
    enum Failure {
        case add(account: String, status: OSStatus)
        case delete(account: String, status: OSStatus)
    }

    private let failure: Failure
    private var values: [String: Data] = [:]

    init(failure: Failure) {
        self.failure = failure
    }

    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
        let account = account(in: query)
        guard values[account] != nil else { return errSecItemNotFound }
        guard let data = attributes[kSecValueData as String] as? Data else { return errSecParam }
        values[account] = data
        return errSecSuccess
    }

    func add(attributes: [String: Any]) -> OSStatus {
        let account = account(in: attributes)
        if case let .add(failingAccount, status) = failure, failingAccount == account {
            return status
        }
        guard let data = attributes[kSecValueData as String] as? Data else { return errSecParam }
        values[account] = data
        return errSecSuccess
    }

    func read(query: [String: Any]) -> (status: OSStatus, data: Data?) {
        guard let data = values[account(in: query)] else {
            return (errSecItemNotFound, nil)
        }
        return (errSecSuccess, data)
    }

    func delete(query: [String: Any]) -> OSStatus {
        let account = account(in: query)
        if case let .delete(failingAccount, status) = failure, failingAccount == account {
            return status
        }
        return values.removeValue(forKey: account) == nil ? errSecItemNotFound : errSecSuccess
    }

    private func account(in attributes: [String: Any]) -> String {
        attributes[kSecAttrAccount as String] as! String
    }
}

final class TerminalRefresh401Tests: XCTestCase {
    func testTerminal401AfterRefreshClearsSessionForStandardRequest() async throws {
        let keychain = KeychainManager(
            testStore: InMemoryKeychainItemStore(failure: .add(account: "unused", status: errSecAuthFailed))
        )
        try keychain.saveServerURL("https://chat.example.com")
        try keychain.saveAuthToken("stale-token")
        Terminal401ChannelsURLProtocol.reset()
        let client = APIClient(session: makeSession(using: Terminal401ChannelsURLProtocol.self), keychain: keychain)

        do {
            let _: [Channel] = try await client.getChannels()
            XCTFail("A second 401 after a successful refresh must fail closed.")
        } catch APIError.unauthorized {
            // Expected: the retry is terminal and must not start another refresh.
        } catch {
            XCTFail("Expected APIError.unauthorized, got: \(error)")
        }

        XCTAssertNil(keychain.authToken)
        XCTAssertEqual(Terminal401ChannelsURLProtocol.refreshRequestCount, 1)
    }

    func testTerminal401AfterRefreshClearsSessionForUpload() async throws {
        let keychain = KeychainManager(
            testStore: InMemoryKeychainItemStore(failure: .add(account: "unused", status: errSecAuthFailed))
        )
        try keychain.saveServerURL("https://chat.example.com")
        try keychain.saveAuthToken("stale-token")
        Terminal401UploadURLProtocol.reset()
        let client = APIClient(session: makeSession(using: Terminal401UploadURLProtocol.self), keychain: keychain)

        do {
            _ = try await client.uploadFile(
                fileData: Data("test".utf8),
                fileName: "test.txt",
                mimeType: "text/plain"
            )
            XCTFail("A second upload 401 after a successful refresh must fail closed.")
        } catch APIError.unauthorized {
            // Expected: the retry is terminal and must not start another refresh.
        } catch {
            XCTFail("Expected APIError.unauthorized, got: \(error)")
        }

        XCTAssertNil(keychain.authToken)
        XCTAssertEqual(Terminal401UploadURLProtocol.refreshRequestCount, 1)
    }

    private func makeSession(using urlProtocol: AnyClass) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [urlProtocol]
        return URLSession(configuration: configuration)
    }
}

private final class Terminal401ChannelsURLProtocol: URLProtocol {
    private static let refreshCounter = LockedCounter()

    static func reset() {
        refreshCounter.reset()
    }

    static var refreshRequestCount: Int {
        refreshCounter.value
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "chat.example.com"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let responseData: (statusCode: Int, body: String)
        switch request.url?.path {
        case "/api/channels":
            responseData = (401, "{\"error\":\"expired\"}")
        case "/api/auth/refresh":
            Self.refreshCounter.increment()
            responseData = (200, "{\"token\":\"refreshed-token\"}")
        default:
            responseData = (500, "{\"error\":\"unexpected path\"}")
        }
        send(statusCode: responseData.statusCode, body: responseData.body)
    }

    override func stopLoading() {}

    private func send(statusCode: Int, body: String) {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: statusCode,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"]
              ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class Terminal401UploadURLProtocol: URLProtocol {
    private static let refreshCounter = LockedCounter()

    static func reset() {
        refreshCounter.reset()
    }

    static var refreshRequestCount: Int {
        refreshCounter.value
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "chat.example.com"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let responseData: (statusCode: Int, body: String)
        switch request.url?.path {
        case "/api/files/upload":
            responseData = (401, "{\"error\":\"expired\"}")
        case "/api/auth/refresh":
            Self.refreshCounter.increment()
            responseData = (200, "{\"token\":\"refreshed-token\"}")
        default:
            responseData = (500, "{\"error\":\"unexpected path\"}")
        }
        send(statusCode: responseData.statusCode, body: responseData.body)
    }

    override func stopLoading() {}

    private func send(statusCode: Int, body: String) {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: statusCode,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"]
              ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func increment() {
        lock.lock()
        defer { lock.unlock() }
        count += 1
    }

    func reset() {
        lock.lock()
        defer { lock.unlock() }
        count = 0
    }
}
