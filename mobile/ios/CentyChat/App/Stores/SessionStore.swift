import Foundation
import Observation
import UIKit

/// What the root view shows.
public enum SessionPhase: Equatable, Sendable {
    case serverSetup
    case signedOut
    case passwordChangeRequired
    case authenticated
}

public enum LoginOutcome: Equatable, Sendable {
    case authenticated
    case passwordChangeRequired
}

public enum ServerProbeError: Error, Equatable, Sendable {
    /// The server answered the health check with a non-OK status.
    case unhealthy(status: String)
}

/// Hooks the session uses to drive the rest of the app.
@MainActor
protocol SessionLifecycleDelegate: AnyObject {
    func sessionNeedsDataReload() async
    func sessionDidEnd()
}

/// Authentication, server configuration and the session lifecycle.
@Observable
@MainActor
public final class SessionStore: RealtimeEventHandling {
    public var isServerConfigured = false
    public var isAuthenticated = false
    public var mustChangePasswordRequired = false
    public private(set) var isLoading = false
    public var errorMessage: String?
    public var currentUser: User?
    public var serverInfo = ServerInfo()

    @ObservationIgnored weak var delegate: (any SessionLifecycleDelegate)?
    @ObservationIgnored private let auth: any AuthRepository
    @ObservationIgnored private let server: any ServerRepository
    @ObservationIgnored private let realtime: RealtimeStore
    @ObservationIgnored private let deviceDescriptor: @MainActor () -> DeviceDescriptor

    init(
        auth: any AuthRepository,
        server: any ServerRepository,
        realtime: RealtimeStore,
        deviceDescriptor: @escaping @MainActor () -> DeviceDescriptor = SessionStore.currentDevice
    ) {
        self.auth = auth
        self.server = server
        self.realtime = realtime
        self.deviceDescriptor = deviceDescriptor
    }

    static func currentDevice() -> DeviceDescriptor {
        DeviceDescriptor(
            name: UIDevice.current.name,
            platform: "iOS \(UIDevice.current.systemVersion)"
        )
    }

    // MARK: - Derived state

    public var phase: SessionPhase {
        if !isServerConfigured { return .serverSetup }
        if !isAuthenticated { return .signedOut }
        return .authenticated
    }

    public var serverAddress: String { server.storedServerURL }
    public var savedUsername: String? { auth.savedUsername }

    /// Absolute URL for a server-relative attachment path.
    public func attachmentURL(for path: String) -> URL? {
        URL(string: "\(server.storedServerURL)\(path)")
    }

    // MARK: - Bootstrap

    public func bootstrap() async {
        isLoading = true
        defer { isLoading = false }

        guard !server.storedServerURL.isEmpty else {
            isServerConfigured = false
            isAuthenticated = false
            return
        }
        isServerConfigured = true

        do {
            let health = try await server.checkHealth()
            guard health.isHealthy else {
                errorMessage = String(localized: "Сервер временно недоступен")
                return
            }
            serverInfo = try await server.fetchServerInfo()
        } catch {
            Log.session.error("Server health check failed: \(error.localizedDescription, privacy: .public)")
        }

        if auth.hasStoredToken {
            do {
                let user = try await auth.currentUser()
                currentUser = user
                isAuthenticated = true
                mustChangePasswordRequired = user.mustChangePassword
                await realtime.connect()
                await delegate?.sessionNeedsDataReload()
            } catch APIError.mustChangePassword(let message) {
                isAuthenticated = true
                mustChangePasswordRequired = true
                errorMessage = message
            } catch APIError.unauthorized {
                do {
                    try auth.clearSession()
                } catch {
                    errorMessage = error.userMessage
                }
                isAuthenticated = false
            } catch {
                Log.session.error("Session validation failed: \(error.localizedDescription, privacy: .public)")
                isAuthenticated = false
            }
        } else {
            await performDeviceKnock()
        }

        await realtime.startListening()
    }

    // MARK: - Device Knock

    public func performDeviceKnock() async {
        do {
            let response = try await auth.knock(device: deviceDescriptor())
            switch response.status {
            case .paired:
                if response.token != nil, let user = response.user {
                    currentUser = user
                    isAuthenticated = true
                    mustChangePasswordRequired = user.mustChangePassword
                    await realtime.connect()
                    await delegate?.sessionNeedsDataReload()
                }
            case .loginRequired, .pending, .tooManyPending:
                isAuthenticated = false
            }
        } catch {
            Log.session.error("Device knock failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Server setup

    /// Checks a candidate server before it is saved.
    public func probeServer(_ url: URL) async throws -> ServerInfo {
        let health = try await server.checkHealth(serverURL: url)
        guard health.isHealthy else {
            throw ServerProbeError.unhealthy(status: health.status)
        }
        return try await server.fetchServerInfo(serverURL: url)
    }

    public func configureServer(address: String, info: ServerInfo) throws {
        try server.saveServerURL(address)
        serverInfo = info
        isServerConfigured = true
    }

    public func returnToServerSetup() {
        isServerConfigured = false
    }

    // MARK: - Login

    public func login(username: String, password: String) async throws -> LoginOutcome {
        let cleanedUsername = username.trimmingCharacters(in: .whitespaces).lowercased()
        do {
            let response = try await auth.login(username: cleanedUsername, password: password)
            currentUser = response.user
            await auth.claimDevice()
            await realtime.connect()

            if response.user.mustChangePassword {
                mustChangePasswordRequired = true
                return .passwordChangeRequired
            }
            isAuthenticated = true
            await delegate?.sessionNeedsDataReload()
            return .authenticated
        } catch APIError.mustChangePassword {
            mustChangePasswordRequired = true
            return .passwordChangeRequired
        }
    }

    // MARK: - Password change

    public func changePassword(oldPassword: String, newPassword: String) async throws {
        let response = try await auth.changePassword(oldPassword: oldPassword, newPassword: newPassword)
        currentUser = response.user
        mustChangePasswordRequired = false
        // Если сокет был отсоединен сервером из-за token_version — переподключаем
        await realtime.connect()
    }

    // MARK: - Logout

    public func logout() async {
        do {
            try await auth.logout()
            await realtime.disconnect()
            handleLogoutOutcome(nil)
        } catch {
            handleLogoutOutcome(error)
        }
    }

    private func handleLogoutOutcome(_ error: (any Error)?) {
        if let error {
            errorMessage = error.userMessage
            return
        }

        currentUser = nil
        isAuthenticated = false
        realtime.stopAudioListener()
        delegate?.sessionDidEnd()
    }

    // MARK: - Realtime

    func handle(_ event: WSServerEvent) {
        switch event {
        case .authSuccess(let user):
            currentUser = user
            isAuthenticated = true
            Task { await delegate?.sessionNeedsDataReload() }

        case .authError(let code, let message):
            if code == "MUST_CHANGE_PASSWORD" {
                mustChangePasswordRequired = true
            } else {
                errorMessage = message
            }

        case .serverDisconnect(let reason):
            errorMessage = reason
            Task { await logout() }

        case .serverError(_, let message, _):
            if let message {
                errorMessage = message
            }

        default:
            break
        }
    }
}
