import Foundation

/// `POST /api/devices/push-token` body (`push.md` §2).
struct PushTokenRegistration: Encodable, Equatable, Sendable {
    enum Environment: String, Encodable, Sendable {
        case sandbox
        case production

        static var current: Environment { .production }
    }

    enum Kind: String, Encodable, Sendable {
        case alert
        case voip
    }

    let platform = "ios"
    let token: String
    let environment: Environment
    let kind: Kind
    let appVersion: String?
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

protocol PushTokenService: Sendable {
    func register(_ registration: PushTokenRegistration) async throws -> PushTokenRegisterResponse
    func unregister(token: String) async throws -> Bool
}

/// Skeleton.
@MainActor
final class PushTokenRegistrar {
    init(
        service: any PushTokenService,
        deviceId: @escaping @MainActor () -> String?,
        appVersion: String?,
        environment: PushTokenRegistration.Environment
    ) {}

    static func hex(_ token: Data) -> String { "" }

    func deviceTokenChanged(_ token: Data) async {}
    func sessionDidAuthenticate() async {}
    func sessionWillSignOut() async {}
    func sessionDidEnd() {}
}

struct DisabledPushTokenService: PushTokenService {
    func register(_ registration: PushTokenRegistration) async throws -> PushTokenRegisterResponse {
        PushTokenRegisterResponse(registered: false, pushEnabled: false)
    }

    func unregister(token: String) async throws -> Bool { false }
}
