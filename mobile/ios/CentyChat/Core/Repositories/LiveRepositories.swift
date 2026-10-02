import Foundation
import Security

struct LiveServerRepository: ServerRepository {
    let client: APIClient

    func checkHealth() async throws -> HealthResponse {
        try await client.checkHealth()
    }

    func fetchServerInfo() async throws -> ServerInfo {
        try await client.getServerInfo()
    }
}

struct LiveAuthRepository: AuthRepository {
    let client: APIClient
    let keychain: KeychainManager

    var hasStoredToken: Bool { keychain.authToken != nil }
    var hasDeviceSecret: Bool { keychain.deviceSecret != nil }
    var savedUsername: String? { keychain.savedUsername }

    func bindStoredCredentials(to origin: String) throws -> StoredCredentialDecision {
        try keychain.bindCredentials(toOrigin: origin)
    }

    func login(username: String, password: String) async throws -> AuthSuccessResponse {
        let response = try await client.login(request: LoginRequest(username: username, password: password))
        // Only a login name that worked is remembered; the password never is.
        do {
            try keychain.saveUsername(username)
        } catch {
            Log.session.error("Remembering the login name failed: \(error.localizedDescription, privacy: .public)")
        }
        return response
    }

    func claimDevice() async {
        do {
            let secret = try Self.makeDeviceSecret()
            let deviceId = try keychain.deviceID()
            let claimed = try await client.claimDevice(deviceId: deviceId, deviceSecret: secret)
            if claimed {
                try keychain.saveDeviceSecret(secret)
            }
        } catch {
            Log.session.error("Device claim failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func knock(device: DeviceDescriptor) async throws -> KnockResponse {
        let request = KnockRequest(
            deviceId: try keychain.deviceID(),
            deviceSecret: keychain.deviceSecret,
            deviceName: device.name,
            platform: device.platform
        )
        let response = try await client.knock(request: request)
        if response.status == .paired, let token = response.token {
            try keychain.saveAuthToken(token)
        }
        return response
    }

    func currentUser() async throws -> User {
        try await client.getCurrentUser()
    }

    func changePassword(oldPassword: String, newPassword: String) async throws -> ChangePasswordResponse {
        try await client.changePassword(request: ChangePasswordRequest(oldPassword: oldPassword, newPassword: newPassword))
    }

    func logout() async throws {
        try await client.logout()
    }

    func clearSession() throws {
        try keychain.clearAllAuthData()
    }

    /// 256-bit URL-safe random secret.
    private static func makeDeviceSecret() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw KeychainManagerError.invalidValue
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

struct LiveChatRepository: ChatRepository {
    let client: APIClient

    func directConversations() async throws -> [DirectConversation] {
        try await client.getDirectConversations()
    }

    func channels() async throws -> [Channel] {
        try await client.getChannels()
    }

    func users() async throws -> [PublicUser] {
        try await client.getUsers()
    }

    func createChannel(name: String, topic: String?, type: ChannelType) async throws -> Channel {
        try await client.createChannel(name: name, topic: topic, type: type)
    }

    func messages(in conversation: ConversationKey, limit: Int, beforeId: Int64?) async throws -> [Message] {
        try await client.getMessages(
            conversationType: conversation.type,
            targetId: conversation.targetId,
            limit: limit,
            beforeId: beforeId
        )
    }

    func uploadFile(data: Data, fileName: String, mimeType: String) async throws -> FileUploadResponse {
        try await client.uploadFile(fileData: data, fileName: fileName, mimeType: mimeType)
    }
}

struct LiveAnnouncementsRepository: AnnouncementsRepository {
    let client: APIClient

    func announcements() async throws -> [Announcement] {
        try await client.getAnnouncements()
    }

    func acknowledge(id: Int64) async throws -> AnnouncementAckResponse {
        try await client.acknowledgeAnnouncement(id: id)
    }
}

struct LiveRealtimeRepository: RealtimeRepository {
    let client: WebSocketClient

    func connect() async {
        await client.connect()
    }

    func disconnect() async {
        await client.disconnect()
    }

    func send(_ message: WSClientMessage) async {
        await client.send(clientMessage: message)
    }

    func sendIfAuthenticated(_ message: WSClientMessage) async -> Bool {
        await client.sendIfAuthenticated(message)
    }

    func sendAudioFrame(_ frame: Data) async {
        await client.sendAudioFrame(frame)
    }

    func events() async -> AsyncStream<WSServerEvent> {
        await client.makeEventStream()
    }

    func incomingAudio() async -> AsyncStream<AudioRelayEngine.DecodedAudioFrame> {
        await client.incomingAudio
    }

    func connectionStates() async -> AsyncStream<RealtimeConnectionState> {
        await client.makeConnectionStateStream()
    }
}
