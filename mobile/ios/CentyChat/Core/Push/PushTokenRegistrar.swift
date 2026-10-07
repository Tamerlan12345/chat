import Foundation

/// `POST /api/devices/push-token` body (`push.md` §2, `openapi.yaml`).
struct PushTokenRegistration: Encodable, Equatable, Sendable {
    /// Which APNs the token belongs to: read from the app's signing (`PushEnvironment`), not from
    /// the build configuration — a development-signed Release build gets sandbox tokens.
    enum Environment: String, Encodable, Sendable {
        case sandbox
        case production

        static var current: Environment {
            PushEnvironment.current
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

/// The server side of push-token registration. Removal needs no call: `/auth/logout` with
/// `device_id`, account deletion and a newer token of the same device drop it (`push.md` §2).
protocol PushTokenService: Sendable {
    func register(_ registration: PushTokenRegistration) async throws -> PushTokenRegisterResponse
}

struct LivePushTokenService: PushTokenService {
    let client: APIClient

    func register(_ registration: PushTokenRegistration) async throws -> PushTokenRegisterResponse {
        try await client.registerPushToken(registration)
    }
}

/// Registers nothing (unit tests that do not look at push).
struct DisabledPushTokenService: PushTokenService {
    func register(_ registration: PushTokenRegistration) async throws -> PushTokenRegisterResponse {
        PushTokenRegisterResponse(registered: false, pushEnabled: false)
    }
}

/// Keeps this device's APNs token registered with the server for the signed-in session
/// (`push.md` §2): after every sign-in and launch with a live session, and on every new token
/// from `didRegisterForRemoteNotificationsWithDeviceToken`. On sign-out nothing more is sent:
/// the server drops the token on `/auth/logout` (with `device_id`) and on account deletion.
///
/// Without an Apple developer account the build has no `aps-environment` entitlement: APNs
/// never hands out a token, so nothing is registered and push is simply off (decision P;
/// `docs/PUSH-SETUP.md` §3).
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
    nonisolated static func hex(_ token: Data) -> String {
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
