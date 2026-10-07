import Foundation
import Observation

/// Which APNs a token belongs to.
enum PushEnvironment {
    static func resolve(profile: Data?, isSimulator: Bool) -> PushTokenRegistration.Environment {
        .current
    }
}

/// A tap on a notification.
enum NotificationTap {
    static func conversation(from userInfo: [AnyHashable: Any]) -> ConversationKey? {
        nil
    }
}

/// A tapped notification's chat, waiting for the chat list.
@Observable
@MainActor
final class NotificationRoutes {
    private(set) var pending: ConversationKey?

    @discardableResult
    func open(_ userInfo: [AnyHashable: Any]) -> Bool {
        false
    }

    func take() -> ConversationKey? {
        nil
    }
}

/// Whether the user lets the app show notifications.
enum NotificationAuthorization: Equatable, Sendable {
    case notDetermined
    case denied
    case allowed
}

protocol NotificationAuthorizing: Sendable {
    func status() async -> NotificationAuthorization
    func request() async -> Bool
}

/// Asks for notification permission.
@MainActor
final class NotificationPermission {
    private let authorization: any NotificationAuthorizing
    private let registerForRemote: @MainActor () -> Void

    init(authorization: any NotificationAuthorizing, registerForRemote: @escaping @MainActor () -> Void) {
        self.authorization = authorization
        self.registerForRemote = registerForRemote
    }

    func signedIn() async {}
}
