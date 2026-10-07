import Foundation

/// Identifies one conversation: a direct dialog with a colleague or a channel.
public struct ConversationKey: Hashable, Sendable {
    public let type: ConversationType
    /// Colleague user id for `.direct`, channel id for `.channel`.
    public let targetId: Int64

    public init(type: ConversationType, targetId: Int64) {
        self.type = type
        self.targetId = targetId
    }

    /// The delivery model's key (`delivery-state.md` §2): `direct:<peer>` / `channel:<id>`.
    public var deliveryKey: String {
        "\(type.rawValue):\(targetId)"
    }
}

/// Describes this device for `/auth/knock`.
public struct DeviceDescriptor: Sendable, Equatable {
    public let name: String
    public let platform: String

    public init(name: String, platform: String) {
        self.name = name
        self.platform = platform
    }
}

// MARK: - Repository protocols
//
// Stores depend only on these protocols; views never touch the network
// singletons. Live implementations wrap `APIClient` / `WebSocketClient`.

/// The server itself is fixed at build time (`ServerEnvironment`); this only reads its status.
public protocol ServerRepository: Sendable {
    func checkHealth() async throws -> HealthResponse
    func fetchServerInfo() async throws -> ServerInfo
}

public protocol AuthRepository: Sendable {
    var hasStoredToken: Bool { get }
    var hasDeviceSecret: Bool { get }
    var savedUsername: String? { get }
    /// Wipes a stored session or device secret that was not issued by `origin`.
    /// Throws when the wipe fails; the stored credentials must then not be used.
    func bindStoredCredentials(to origin: String) throws -> StoredCredentialDecision
    /// Persists the username and the session token; fails closed if the token cannot be stored.
    func login(username: String, password: String) async throws -> AuthSuccessResponse
    /// Best-effort binding of a fresh device secret for password-less re-entry.
    func claimDevice() async
    /// Persists the token when the device is paired.
    func knock(device: DeviceDescriptor) async throws -> KnockResponse
    func currentUser() async throws -> User
    /// Persists the new token issued by the server.
    func changePassword(oldPassword: String, newPassword: String) async throws -> ChangePasswordResponse
    func logout() async throws
    func clearSession() throws
    /// The signed-in user kept for a launch without the server (nil — none kept).
    var storedUser: User? { get }
    /// Keeps `user` for the next launch without the server; best effort.
    func rememberUser(_ user: User)
}

public extension AuthRepository {
    var storedUser: User? { nil }
    func rememberUser(_ user: User) {}
}

public protocol ChatRepository: Sendable {
    func directConversations() async throws -> [DirectConversation]
    func channels() async throws -> [Channel]
    func users() async throws -> [PublicUser]
    func createChannel(name: String, topic: String?, type: ChannelType) async throws -> Channel
    func messages(in conversation: ConversationKey, limit: Int, beforeId: Int64?) async throws -> [Message]
    /// The oldest `limit` messages newer than `afterId`, oldest first (history after a search hit).
    func messages(in conversation: ConversationKey, limit: Int, afterId: Int64) async throws -> [Message]
    /// `GET /api/messages/search?q=` — newest first, at most 30, rate-limited to 30 a minute.
    func searchMessages(_ query: String) async throws -> [Message]
    func uploadFile(data: Data, fileName: String, mimeType: String) async throws -> FileUploadResponse
    /// The server's records of a page (`beforeId` — older than it; nil — the newest), oldest first.
    func messageRecords(in conversation: ConversationKey, limit: Int, beforeId: Int64?) async throws -> [JSONObject]
    /// The oldest `limit` records newer than `afterId`, oldest first.
    func messageRecords(in conversation: ConversationKey, limit: Int, afterId: Int64) async throws -> [JSONObject]
    /// `GET /api/files/policy`: what may be sent.
    func filePolicy() async throws -> FilePolicyEffectiveResponse
}

public protocol AnnouncementsRepository: Sendable {
    func announcements() async throws -> [Announcement]
    func acknowledge(id: Int64) async throws -> AnnouncementAckResponse
}

public protocol RealtimeRepository: Sendable {
    func connect() async
    func disconnect() async
    func send(_ message: WSClientMessage) async
    /// Sends only on a socket the server has authenticated; false when it was not sent.
    func sendIfAuthenticated(_ message: WSClientMessage) async -> Bool
    func sendAudioFrame(_ frame: Data) async
    func events() async -> AsyncStream<WSServerEvent>
    func incomingAudio() async -> AsyncStream<AudioRelayEngine.DecodedAudioFrame>
    func connectionStates() async -> AsyncStream<RealtimeConnectionState>
    /// Every server frame as received, and `closed` when a socket goes away (the delivery engine).
    func deliveryFrames() async -> AsyncStream<DeliveryLinkFrame>
    /// Writes a delivery frame on the authenticated socket; false when it was not written.
    func sendFrame(_ frame: JSONObject) async -> Bool
    /// Drops the socket so it reconnects.
    func restartLink() async
    /// A reconnect waiting for its backoff goes now (the network came back).
    func reconnectNow() async
    /// The user of the authenticated socket; nil without one.
    func authenticatedUserId() async -> Int64?
}
