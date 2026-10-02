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
}

public protocol ChatRepository: Sendable {
    func directConversations() async throws -> [DirectConversation]
    func channels() async throws -> [Channel]
    func users() async throws -> [PublicUser]
    func createChannel(name: String, topic: String?, type: ChannelType) async throws -> Channel
    func messages(in conversation: ConversationKey, limit: Int, beforeId: Int64?) async throws -> [Message]
    func uploadFile(data: Data, fileName: String, mimeType: String) async throws -> FileUploadResponse
}

public protocol AnnouncementsRepository: Sendable {
    func announcements() async throws -> [Announcement]
    func acknowledge(id: Int64) async throws -> AnnouncementAckResponse
}

public protocol RealtimeRepository: Sendable {
    func connect() async
    func disconnect() async
    func send(_ message: WSClientMessage) async
    func sendAudioFrame(_ frame: Data) async
    func events() async -> AsyncStream<WSServerEvent>
    func incomingAudio() async -> AsyncStream<AudioRelayEngine.DecodedAudioFrame>
    func connectionStates() async -> AsyncStream<RealtimeConnectionState>
}
