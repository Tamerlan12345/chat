import Foundation

/// `POST /api/devices/push-token` body (`push.md` §2, `openapi.yaml`).
struct PushTokenRegistration: Encodable, Equatable, Sendable {
    /// Which APNs the token belongs to: builds run from Xcode get sandbox tokens,
    /// TestFlight and App Store builds production ones.
    enum Environment: String, Encodable, Sendable {
        case sandbox
        case production

        static var current: Environment {
#if DEBUG
            return .sandbox
#else
            return .production
#endif
        }
    }

    /// `alert` — the APNs token for messages; `voip` — the PushKit token for calls.
    enum Kind: String, Encodable, Sendable {
        case alert
        case voip
    }

    let platform = "ios"
    let token: String
    let environment: Environment
    let kind: Kind
    let appVersion: String?
    /// The same id as in `/auth/knock` and `/auth/logout`: a new token of this device replaces the old one.
    let deviceId: String?

    init(token: String, environment: Environment, kind: Kind, appVersion: String?, deviceId: String?) {
        self.token = token
        self.environment = environment
        self.kind = kind
        self.appVersion = appVersion
        self.deviceId = deviceId
    }

    enum CodingKeys: String, CodingKey {
        case platform
        case token
        case environment
        case kind
        case appVersion = "app_version"
        case deviceId = "device_id"
    }
}

/// The server side of push-token registration.
protocol PushTokenService: Sendable {
    func register(_ registration: PushTokenRegistration) async throws -> PushTokenRegisterResponse
    func unregister(token: String) async throws -> Bool
}

struct LivePushTokenService: PushTokenService {
    let client: APIClient

    func register(_ registration: PushTokenRegistration) async throws -> PushTokenRegisterResponse {
        try await client.registerPushToken(registration)
    }

    func unregister(token: String) async throws -> Bool {
        try await client.unregisterPushToken(token)
    }
}

/// Registers nothing (unit tests that do not look at push).
struct DisabledPushTokenService: PushTokenService {
    func register(_ registration: PushTokenRegistration) async throws -> PushTokenRegisterResponse {
        PushTokenRegisterResponse(registered: false, pushEnabled: false)
    }

    func unregister(token: String) async throws -> Bool { false }
}

/// Keeps this device's APNs token registered with the server for the signed-in session
/// (`push.md` §2): after every sign-in and launch with a live session, and on every new token
/// from `didRegisterForRemoteNotificationsWithDeviceToken`. On sign-out the token is removed
/// (the server also drops it on `/auth/logout` and on account deletion).
///
/// Without an Apple developer account the build has no `aps-environment` entitlement: APNs
/// never hands out a token, so nothing is registered.
@MainActor
final class PushTokenRegistrar {
    private let service: any PushTokenService
    private let deviceId: @MainActor () -> String?
    private let appVersion: String?
    private let environment: PushTokenRegistration.Environment

    /// The latest APNs token (lowercase hex).
    private(set) var deviceToken: String?
    /// The token the server accepted for the current session.
    private(set) var registeredToken: String?
    private var hasSession = false

    init(
        service: any PushTokenService,
        deviceId: @escaping @MainActor () -> String?,
        appVersion: String?,
        environment: PushTokenRegistration.Environment
    ) {
        self.service = service
        self.deviceId = deviceId
        self.appVersion = appVersion
        self.environment = environment
    }

    /// APNs hands the token out as bytes; the server takes lowercase hex.
    static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    func deviceTokenChanged(_ token: Data) async {
        let hex = Self.hex(token)
        guard hex != deviceToken else { return }
        deviceToken = hex
        await registerIfPossible()
    }

    func sessionDidAuthenticate() async {
        hasSession = true
        await registerIfPossible()
    }

    /// Called while the session is still valid, before `/auth/logout`. Best effort.
    func sessionWillSignOut() async {
        hasSession = false
        guard let token = registeredToken else { return }
        registeredToken = nil
        do {
            _ = try await service.unregister(token: token)
        } catch {
            Log.session.notice("Push token removal failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The session is gone (sign-out, revoked token, deleted account): nothing more is sent.
    func sessionDidEnd() {
        hasSession = false
        registeredToken = nil
    }

    private func registerIfPossible() async {
        guard hasSession, let token = deviceToken else { return }
        let registration = PushTokenRegistration(
            token: token,
            environment: environment,
            kind: .alert,
            appVersion: appVersion,
            deviceId: deviceId()
        )
        do {
            _ = try await service.register(registration)
            if hasSession, deviceToken == token {
                registeredToken = token
            }
        } catch {
            // Retried at the next sign-in, launch or token change.
            Log.session.notice("Push token registration failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
