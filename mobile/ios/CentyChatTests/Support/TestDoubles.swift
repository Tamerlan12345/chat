import Foundation
import XCTest
@testable import CentyChat

// MARK: - Thread-safe box

final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Value

    init(_ value: Value) {
        storage = value
    }

    var value: Value {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func withValue<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
        lock.lock()
        defer { lock.unlock() }
        return try body(&storage)
    }
}

struct TestError: Error, LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
}

// MARK: - Models

enum TestModels {
    static let me = user(id: 1, name: "Тест Тестов")
    static let colleague = user(id: 12, name: "Данияр Нурпеисов")

    static func user(id: Int64, name: String, mustChangePassword: Bool = false) -> User {
        User(id: id, username: "user\(id)", fullName: name, status: .online, mustChangePassword: mustChangePassword)
    }

    static func message(
        id: Int64,
        from senderId: Int64,
        to targetId: Int64,
        type: ConversationType = .direct,
        text: String = "Привет",
        deliveryStatus: DeliveryStatus? = nil
    ) -> Message {
        Message(
            id: id,
            conversationType: type,
            targetId: targetId,
            senderId: senderId,
            text: text,
            senderName: "Отправитель",
            deliveryStatus: deliveryStatus
        )
    }

    static func direct(with userId: Int64, unread: Int = 0) -> DirectConversation {
        DirectConversation(userId: userId, fullName: "Коллега \(userId)", unreadCount: unread)
    }

    static func channel(id: Int64, unread: Int = 0) -> Channel {
        Channel(id: id, name: "#канал-\(id)", unreadCount: unread)
    }

    static func announcement(id: Int64) -> Announcement {
        Announcement(id: id, authorId: 1, title: "Объявление \(id)", content: "Текст", authorName: "Администратор")
    }

    /// Raw server frame → parsed event, as the socket would deliver it.
    static func event(_ json: String) -> WSServerEvent {
        guard let event = WSServerEvent.parse(from: Data(json.utf8)) else {
            fatalError("Unparseable test frame: \(json)")
        }
        return event
    }
}

// MARK: - Repositories

final class FakeServerRepository: ServerRepository, @unchecked Sendable {
    private let healthy: Locked<Bool>
    let info = Locked(ServerInfo(companyName: "ТОО «Тестовая компания»"))

    init(healthy: Bool = true) {
        self.healthy = Locked(healthy)
    }

    func setHealthy(_ healthy: Bool) {
        self.healthy.withValue { $0 = healthy }
    }

    func checkHealth() async throws -> HealthResponse {
        HealthResponse(status: healthy.value ? "ok" : "maintenance", error: nil)
    }

    func fetchServerInfo() async throws -> ServerInfo {
        info.value
    }
}

final class FakeAuthRepository: AuthRepository, @unchecked Sendable {
    struct State {
        var hasToken = false
        var loginUser: User = TestModels.me
        var loginError: (any Error)?
        var currentUserResult: Result<User, any Error> = .success(TestModels.me)
        var knockStatus: KnockStatus = .loginRequired
        var changedPasswordUser: User = TestModels.me
        var logoutError: (any Error)?
        var loginCount = 0
        var changePasswordCount = 0
        var logoutCount = 0
        var hasDeviceSecret = false
        /// Origin the stored token/secret was issued for.
        var issuerOrigin: String? = ServerEnvironment.test.origin
        var bindError: (any Error)?
        var loginGate: TestGate?
        var currentUserCount = 0
        var knockCount = 0
    }

    let state = Locked(State())

    var hasStoredToken: Bool { state.value.hasToken }
    var hasDeviceSecret: Bool { state.value.hasDeviceSecret }
    var savedUsername: String? { nil }

    func bindStoredCredentials(to origin: String) throws -> StoredCredentialDecision {
        try state.withValue { state in
            if let error = state.bindError { throw error }
            let hasCredentials = state.hasToken || state.hasDeviceSecret
            defer { state.issuerOrigin = origin }
            guard hasCredentials else { return .nothingStored }
            guard state.issuerOrigin == origin else {
                state.hasToken = false
                state.hasDeviceSecret = false
                return .wiped
            }
            return .kept
        }
    }

    func login(username: String, password: String) async throws -> AuthSuccessResponse {
        if let gate = state.value.loginGate {
            await gate.wait()
        }
        return try state.withValue { state in
            state.loginCount += 1
            if let error = state.loginError { throw error }
            state.hasToken = true
            return AuthSuccessResponse(user: state.loginUser, token: "token-\(state.loginCount)")
        }
    }

    func claimDevice() async {}

    func knock(device: DeviceDescriptor) async throws -> KnockResponse {
        state.withValue { state in
            state.knockCount += 1
            if state.knockStatus == .paired {
                state.hasToken = true
                return KnockResponse(status: .paired, message: nil, deviceId: "device", deviceName: device.name, user: state.loginUser, token: "knock-token")
            }
            return KnockResponse(status: state.knockStatus, message: nil, deviceId: "device", deviceName: device.name, user: nil, token: nil)
        }
    }

    func currentUser() async throws -> User {
        try state.withValue { state in
            state.currentUserCount += 1
            return try state.currentUserResult.get()
        }
    }

    func changePassword(oldPassword: String, newPassword: String) async throws -> ChangePasswordResponse {
        state.withValue { state in
            state.changePasswordCount += 1
            state.hasToken = true
            return ChangePasswordResponse(success: true, message: "ok", token: "changed-token", user: state.changedPasswordUser)
        }
    }

    func logout() async throws {
        try state.withValue { state in
            state.logoutCount += 1
            if let error = state.logoutError { throw error }
            state.hasToken = false
        }
    }

    func clearSession() throws {
        state.withValue { $0.hasToken = false }
    }
}

final class FakeChatRepository: ChatRepository, @unchecked Sendable {
    struct State {
        var directs: Result<[DirectConversation], any Error> = .success([])
        var channels: Result<[Channel], any Error> = .success([])
        var users: Result<[PublicUser], any Error> = .success([])
        var messages: [ConversationKey: [Message]] = [:]
        var directLoadCount = 0
    }

    let state = Locked(State())

    func directConversations() async throws -> [DirectConversation] {
        try state.withValue { state in
            state.directLoadCount += 1
            return try state.directs.get()
        }
    }

    func channels() async throws -> [Channel] {
        try state.value.channels.get()
    }

    func users() async throws -> [PublicUser] {
        try state.value.users.get()
    }

    func createChannel(name: String, topic: String?, type: ChannelType) async throws -> Channel {
        Channel(id: 999, name: name, topic: topic, type: type)
    }

    func messages(in conversation: ConversationKey, limit: Int, beforeId: Int64?) async throws -> [Message] {
        state.value.messages[conversation] ?? []
    }

    func uploadFile(data: Data, fileName: String, mimeType: String) async throws -> FileUploadResponse {
        throw TestError(message: "upload not supported in tests")
    }
}

final class FakeAnnouncementsRepository: AnnouncementsRepository, @unchecked Sendable {
    let items = Locked<Result<[Announcement], any Error>>(.success([]))

    func announcements() async throws -> [Announcement] {
        try items.value.get()
    }

    func acknowledge(id: Int64) async throws -> AnnouncementAckResponse {
        AnnouncementAckResponse(success: true, announcementId: id, confirmedAt: "2026-10-02T09:00:00.000Z")
    }
}

/// Mirrors `WebSocketClient` stream semantics: a new subscription replaces the
/// previous one and `disconnect()` finishes the audio stream.
actor FakeRealtimeRepository: RealtimeRepository {
    private(set) var connectCount = 0
    private(set) var disconnectCount = 0
    private(set) var isConnected = false
    private(set) var sent: [WSClientMessage] = []
    private(set) var eventSubscriptions = 0
    private(set) var audioSubscriptions = 0
    private var eventContinuation: AsyncStream<WSServerEvent>.Continuation?
    private var audioContinuation: AsyncStream<AudioRelayEngine.DecodedAudioFrame>.Continuation?
    private var stateContinuation: AsyncStream<RealtimeConnectionState>.Continuation?

    func connect() {
        connectCount += 1
        isConnected = true
        stateContinuation?.yield(.connected)
    }

    func disconnect() {
        disconnectCount += 1
        isConnected = false
        audioContinuation?.finish()
        audioContinuation = nil
        stateContinuation?.yield(.disconnected)
    }

    func send(_ message: WSClientMessage) {
        sent.append(message)
    }

    func sendAudioFrame(_ frame: Data) {}

    func events() -> AsyncStream<WSServerEvent> {
        eventSubscriptions += 1
        eventContinuation?.finish()
        let (stream, continuation) = AsyncStream<WSServerEvent>.makeStream()
        eventContinuation = continuation
        return stream
    }

    func incomingAudio() -> AsyncStream<AudioRelayEngine.DecodedAudioFrame> {
        audioSubscriptions += 1
        audioContinuation?.finish()
        let (stream, continuation) = AsyncStream<AudioRelayEngine.DecodedAudioFrame>.makeStream()
        audioContinuation = continuation
        return stream
    }

    func connectionStates() -> AsyncStream<RealtimeConnectionState> {
        stateContinuation?.finish()
        let (stream, continuation) = AsyncStream<RealtimeConnectionState>.makeStream()
        stateContinuation = continuation
        continuation.yield(isConnected ? .connected : .disconnected)
        return stream
    }

    /// Delivers a server event to the current subscriber. Returns false if nobody listens.
    @discardableResult
    func emit(_ event: WSServerEvent) -> Bool {
        guard let eventContinuation else { return false }
        if case .terminated = eventContinuation.yield(event) { return false }
        return true
    }

    var hasLiveAudioSubscriber: Bool { audioContinuation != nil }

    var sentTypes: [String] {
        sent.compactMap { message in
            guard let data = message.toJSONData(),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return json["type"] as? String
        }
    }
}

// MARK: - Container

@MainActor
struct TestApp {
    let container: AppContainer
    let server: FakeServerRepository
    let auth: FakeAuthRepository
    let chat: FakeChatRepository
    let announcements: FakeAnnouncementsRepository
    let realtime: FakeRealtimeRepository

    init(environment: ServerEnvironment = .test) {
        server = FakeServerRepository()
        auth = FakeAuthRepository()
        chat = FakeChatRepository()
        announcements = FakeAnnouncementsRepository()
        realtime = FakeRealtimeRepository()
        container = AppContainer(
            server: server,
            auth: auth,
            chat: chat,
            announcements: announcements,
            realtime: realtime,
            environment: environment,
            audioRelayFactory: { peerId in
                AudioCallRelay(targetUserId: peerId, backend: SilentAudioBackend(), sendFrame: { _ in })
            },
            deviceDescriptor: { DeviceDescriptor(name: "Test iPhone", platform: "iOS 17") }
        )
    }

    var session: SessionStore { container.session }
}

/// Lets the main actor run queued tasks (event pumps, detached reloads).
@MainActor
func settle(_ iterations: Int = 20) async {
    for _ in 0..<iterations {
        await Task.yield()
    }
}

/// Polls a main-actor condition until it holds or the timeout expires.
@MainActor
func eventually(
    timeout: TimeInterval = 2,
    _ condition: @MainActor () async -> Bool
) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return await condition()
}

@MainActor
final class SilentAudioBackend: AudioRelayBackend {
    var recordPermission: AudioRecordPermission = .granted
    var lifecycleHandler: ((AudioRelayBackendEvent) -> Void)?

    func requestRecordPermission() async -> Bool { true }
    func startCapture(_ handler: @escaping ([Float]) -> Void) throws {}
    func stop() {}
    func pause() {}
    func reactivateAudioSession() throws {}
    func resume() throws {}
    func handleRouteChange() throws {}
    func resetPlayback() {}
    func schedulePlayback(samples: [Float], at time: TimeInterval) throws {}
}
