import Foundation
import Observation
import UIKit

/// What the root view shows.
public enum SessionPhase: Equatable, Sendable {
    /// A server is configured and the stored session is being restored.
    case launching
    case serverSetup
    case signedOut
    /// The server requires a new password before anything else; shown once, as the root screen.
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
    /// The session just became authenticated (login, restore, knock or finished password change).
    func sessionDidAuthenticate() async
    /// The realtime socket re-authenticated after a reconnect; state may have been missed.
    func sessionDidResume() async
    /// The session ended (logout or revoked token).
    func sessionDidEnd()
}

/// Authentication, server configuration and the session lifecycle.
///
/// Realtime listening is tied to the phase: it starts whenever the session becomes
/// authenticated and stops whenever it leaves that phase.
@Observable
@MainActor
public final class SessionStore: RealtimeEventHandling {
    public private(set) var phase: SessionPhase
    public var currentUser: User?
    public private(set) var serverInfo = ServerInfo()
    public var errorMessage: String?

    @ObservationIgnored weak var delegate: (any SessionLifecycleDelegate)?
    @ObservationIgnored private let auth: any AuthRepository
    @ObservationIgnored private let server: any ServerRepository
    @ObservationIgnored private let realtime: RealtimeStore
    @ObservationIgnored private let deviceDescriptor: @MainActor () -> DeviceDescriptor
    @ObservationIgnored private var hasRealtimeAuthenticated = false
    @ObservationIgnored private var isRevalidating = false

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
        self.phase = server.storedServerURL.isEmpty ? .serverSetup : .launching
    }

    static func currentDevice() -> DeviceDescriptor {
        DeviceDescriptor(
            name: UIDevice.current.name,
            platform: "iOS \(UIDevice.current.systemVersion)"
        )
    }

    public var isAuthenticated: Bool { phase == .authenticated }
    public var serverAddress: String { server.storedServerURL }
    public var savedUsername: String? { auth.savedUsername }

    /// Absolute URL for a server-relative attachment path.
    public func attachmentURL(for path: String) -> URL? {
        URL(string: "\(server.storedServerURL)\(path)")
    }

    // MARK: - Bootstrap

    public func bootstrap() async {
        guard !server.storedServerURL.isEmpty else {
            phase = .serverSetup
            return
        }
        if phase == .serverSetup {
            phase = .launching
        }

        await refreshServerInfo()

        if auth.hasStoredToken {
            await restoreStoredSession()
        } else {
            let paired = await knock()
            if !paired {
                phase = .signedOut
            }
        }
    }

    /// Health is advisory: an unhealthy answer is reported but the session is still restored.
    private func refreshServerInfo() async {
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
    }

    private func restoreStoredSession() async {
        do {
            await enter(try await auth.currentUser())
        } catch APIError.mustChangePassword {
            await requirePasswordChange()
        } catch APIError.unauthorized {
            // An expired token cannot be refreshed: try the device secret, else sign in again.
            clearStoredCredentials()
            let paired = await knock()
            if !paired {
                phase = .signedOut
            }
        } catch {
            Log.session.error("Session validation failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = error.userMessage
            phase = .signedOut
        }
    }

    /// Password-less entry with the device secret. Returns true when the device is paired.
    private func knock() async -> Bool {
        do {
            let response = try await auth.knock(device: deviceDescriptor())
            guard response.status == .paired, response.token != nil, let user = response.user else {
                return false
            }
            await enter(user)
            return true
        } catch {
            Log.session.error("Device knock failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Moves to the authenticated phase, or to the mandatory password change when the server demands it.
    private func enter(_ user: User) async {
        currentUser = user
        guard !user.mustChangePassword else {
            await requirePasswordChange()
            return
        }
        let wasAuthenticated = phase == .authenticated
        phase = .authenticated
        hasRealtimeAuthenticated = false
        await realtime.start()
        if !wasAuthenticated {
            await delegate?.sessionDidAuthenticate()
        }
    }

    /// The server refuses REST and realtime until the password is changed.
    private func requirePasswordChange() async {
        phase = .passwordChangeRequired
        await realtime.stop()
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
        phase = .signedOut
    }

    public func returnToServerSetup() {
        guard phase == .signedOut else { return }
        phase = .serverSetup
    }

    // MARK: - Login

    public func login(username: String, password: String) async throws -> LoginOutcome {
        let cleanedUsername = username.trimmingCharacters(in: .whitespaces).lowercased()
        do {
            let response = try await auth.login(username: cleanedUsername, password: password)
            // Device Claim для беспарольного входа (Parity Matrix Section 2)
            await auth.claimDevice()
            await enter(response.user)
        } catch APIError.mustChangePassword(let message) {
            guard auth.hasStoredToken else {
                throw APIError.mustChangePassword(message: message)
            }
            await requirePasswordChange()
        }
        return phase == .passwordChangeRequired ? .passwordChangeRequired : .authenticated
    }

    // MARK: - Password change

    public func changePassword(oldPassword: String, newPassword: String) async throws {
        let response = try await auth.changePassword(oldPassword: oldPassword, newPassword: newPassword)
        if phase == .authenticated && !response.user.mustChangePassword {
            currentUser = response.user
            // The server revoked the token the open socket authenticated with.
            hasRealtimeAuthenticated = false
            await realtime.reconnect()
        } else {
            await enter(response.user)
        }
    }

    // MARK: - Logout

    public func logout() async {
        do {
            try await auth.logout()
        } catch {
            // Fail closed: the token is still stored, so the session stays as it is.
            errorMessage = error.userMessage
            return
        }
        await endSession()
    }

    private func endSession() async {
        await realtime.stop()
        currentUser = nil
        phase = .signedOut
        delegate?.sessionDidEnd()
    }

    private func clearStoredCredentials() {
        do {
            try auth.clearSession()
        } catch {
            Log.session.error("Clearing stored credentials failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Revalidation

    /// Called when the server drops or rejects the socket. A still-valid (or refreshable)
    /// token keeps the session and reconnects; a revoked one falls back to the device
    /// secret and otherwise signs out.
    func revalidate(reason: String) async {
        guard phase == .authenticated, !isRevalidating else { return }
        isRevalidating = true
        defer { isRevalidating = false }

        do {
            let user = try await auth.currentUser()
            guard !user.mustChangePassword else {
                await enter(user)
                return
            }
            currentUser = user
            hasRealtimeAuthenticated = false
            await realtime.reconnect()
        } catch APIError.mustChangePassword {
            await requirePasswordChange()
        } catch APIError.unauthorized {
            clearStoredCredentials()
            await realtime.stop()
            let paired = await knock()
            if !paired {
                await endSession()
                errorMessage = reason
            }
        } catch {
            // Offline: keep the session; the socket keeps retrying with backoff.
            Log.session.error("Revalidation failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Realtime

    func handle(_ event: WSServerEvent) {
        switch event {
        case .authSuccess(let user):
            guard phase == .authenticated else { return }
            currentUser = user
            if hasRealtimeAuthenticated {
                // A reconnect: pick up anything missed while offline.
                Task { await delegate?.sessionDidResume() }
            }
            hasRealtimeAuthenticated = true

        case .authError(let code, let message):
            switch code {
            case "MUST_CHANGE_PASSWORD":
                Task { await requirePasswordChange() }
            case "INVALID_TOKEN":
                Task { await revalidate(reason: message) }
            default:
                errorMessage = message
            }

        case .serverDisconnect(let reason):
            Task { await revalidate(reason: reason) }

        case .serverError(_, let message, _):
            if let message {
                errorMessage = message
            }

        default:
            break
        }
    }
}
