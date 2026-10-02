import Foundation
import Observation
import UIKit

/// What the root view shows.
public enum SessionPhase: Equatable, Sendable {
    /// A stored session or device secret is being restored.
    case launching
    case signedOut
    /// The server requires a new password before anything else; shown once, as the root screen.
    case passwordChangeRequired
    case authenticated
}

public enum LoginOutcome: Equatable, Sendable {
    case authenticated
    case passwordChangeRequired
}

public enum SessionError: Error, Equatable, Sendable {
    /// A login request is already in flight; a second one is not sent.
    case loginInProgress
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

/// Authentication and the session lifecycle against the build's fixed server.
///
/// Realtime listening is tied to the phase: it starts whenever the session becomes
/// authenticated and stops whenever it leaves that phase.
@Observable
@MainActor
public final class SessionStore: RealtimeEventHandling {
    public private(set) var phase: SessionPhase
    public var currentUser: User?
    public private(set) var serverInfo = ServerInfo()
    /// `company_name` from `/api/settings/info`, once the server has answered.
    public private(set) var companyName: String?
    public private(set) var isSigningIn = false
    public var errorMessage: String?

    @ObservationIgnored weak var delegate: (any SessionLifecycleDelegate)?
    @ObservationIgnored private let auth: any AuthRepository
    @ObservationIgnored private let server: any ServerRepository
    @ObservationIgnored private let environment: ServerEnvironment
    @ObservationIgnored private let realtime: RealtimeStore
    @ObservationIgnored private let deviceDescriptor: @MainActor () -> DeviceDescriptor
    @ObservationIgnored private var hasRealtimeAuthenticated = false
    @ObservationIgnored private var isRevalidating = false

    init(
        auth: any AuthRepository,
        server: any ServerRepository,
        realtime: RealtimeStore,
        environment: ServerEnvironment,
        deviceDescriptor: @escaping @MainActor () -> DeviceDescriptor = SessionStore.currentDevice
    ) {
        self.auth = auth
        self.server = server
        self.realtime = realtime
        self.environment = environment
        self.deviceDescriptor = deviceDescriptor
        // A fresh install has nothing to restore and goes straight to login.
        self.phase = auth.hasStoredToken || auth.hasDeviceSecret ? .launching : .signedOut
    }

    static func currentDevice() -> DeviceDescriptor {
        DeviceDescriptor(
            name: UIDevice.current.name,
            platform: "iOS \(UIDevice.current.systemVersion)"
        )
    }

    public var isAuthenticated: Bool { phase == .authenticated }
    public var savedUsername: String? { auth.savedUsername }

    /// Absolute URL for a server-relative attachment path (`/api/files/download/1`).
    /// Anything else, including absolute URLs to other hosts, is refused.
    public func attachmentURL(for path: String) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
        return URL(string: path, relativeTo: environment.serverURL)?.absoluteURL
    }

    // MARK: - Bootstrap

    public func bootstrap() async {
        // Credentials issued by another server are wiped before anything is sent.
        guard bindStoredCredentials() else {
            // Fail closed: the foreign credentials could not be removed, so they are not used.
            phase = .signedOut
            await refreshServerInfo()
            return
        }
        if phase == .launching && !auth.hasStoredToken && !auth.hasDeviceSecret {
            phase = .signedOut
        }

        await refreshServerInfo()

        if auth.hasStoredToken {
            await restoreStoredSession()
        } else {
            await enterWithDeviceSecret()
        }
    }

    /// Returns false when credentials from another server are stored and could not be wiped.
    private func bindStoredCredentials() -> Bool {
        do {
            if try auth.bindStoredCredentials(to: environment.origin) == .wiped {
                Log.session.notice("Discarded credentials issued by another server")
            }
            return true
        } catch {
            Log.session.error("Wiping foreign credentials failed: \(error.localizedDescription, privacy: .public)")
            return false
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
            let info = try await server.fetchServerInfo()
            serverInfo = info
            companyName = info.companyName
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
            await enterWithDeviceSecret()
        } catch {
            Log.session.error("Session validation failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = error.userMessage
            phase = .signedOut
        }
    }

    /// Password-less entry with the device secret. Returns the user when the device is paired.
    private func knock() async -> User? {
        do {
            let response = try await auth.knock(device: deviceDescriptor())
            guard response.status == .paired, response.token != nil, let user = response.user else {
                return nil
            }
            return user
        } catch {
            Log.session.error("Device knock failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Launch-time knock. The login screen may already be in use, so a late answer
    /// never overrides a login the user started or finished meanwhile.
    private func enterWithDeviceSecret() async {
        let user = await knock()
        guard !isSigningIn, phase != .authenticated, phase != .passwordChangeRequired else { return }
        if let user {
            await enter(user)
        } else {
            phase = .signedOut
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

    // MARK: - Login

    /// Signs in with a login and password. The password is passed straight to the request
    /// and never stored. A second call while one is in flight throws `loginInProgress`.
    public func login(username: String, password: String) async throws -> LoginOutcome {
        guard !isSigningIn else { throw SessionError.loginInProgress }
        isSigningIn = true
        defer { isSigningIn = false }
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
            if let user = await knock() {
                await enter(user)
            } else {
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
