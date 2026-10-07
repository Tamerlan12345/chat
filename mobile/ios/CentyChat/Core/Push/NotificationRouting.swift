import Foundation
import Observation

/// Which APNs a token belongs to (decision P): read from how the app was signed, never guessed from
/// the build configuration (a development-signed Release build gets sandbox tokens).
///
/// - A provisioning profile embedded in the app (Xcode and ad-hoc/enterprise installs) names it in
///   `Entitlements.aps-environment`: `development` — sandbox, `production` — production.
/// - App Store and TestFlight builds carry no profile: production.
/// - The simulator (no profile, or one without push) registers with the sandbox.
enum PushEnvironment {
    static func resolve(profile: Data?, isSimulator: Bool) -> PushTokenRegistration.Environment {
        if let profile, let aps = apsEnvironment(inProfile: profile) {
            return aps == "development" ? .sandbox : .production
        }
        return isSimulator ? .sandbox : .production
    }

    /// The running app's signing.
    static var current: PushTokenRegistration.Environment {
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? Data(contentsOf: $0) }
#if targetEnvironment(simulator)
        return resolve(profile: profile, isSimulator: true)
#else
        return resolve(profile: profile, isSimulator: false)
#endif
    }

    /// `aps-environment` of the property list inside a profile's CMS envelope.
    static func apsEnvironment(inProfile data: Data) -> String? {
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex) else { return nil }
        let plist = data.subdata(in: start.lowerBound..<end.upperBound)
        guard let root = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
              let entitlements = root["Entitlements"] as? [String: Any] else { return nil }
        return entitlements["aps-environment"] as? String
    }
}

/// A tap on a notification (`push.md` §4): only a message notification opens a chat, and its
/// payload carries ids only — the chat's content comes from the server. Only this app's own
/// notifications reach the app's delegate, local (socket `notify`) and remote alike.
enum NotificationTap {
    static func conversation(from userInfo: [AnyHashable: Any]) -> ConversationKey? {
        guard case .message(let conversation, _)? = PushPayload.parse(userInfo) else { return nil }
        return conversation
    }
}

/// A tapped notification's chat, waiting for the chat list to open it (it may be tapped before the
/// session is restored; the chat list appears only for a signed-in user). The tap belongs to the
/// account signed in when it came (nil — the stored session being restored): another account never
/// opens it, and the end of the session drops it.
@Observable
@MainActor
final class NotificationRoutes {
    private(set) var pending: ConversationKey?
    @ObservationIgnored private var account: Int64?
    /// Bumped by every tap, so the same chat tapped twice opens twice.
    private(set) var serial = 0

    /// A tapped notification; false when it opens nothing.
    @discardableResult
    func open(_ userInfo: [AnyHashable: Any], account: Int64?) -> Bool {
        guard let conversation = NotificationTap.conversation(from: userInfo) else { return false }
        open(conversation, account: account)
        return true
    }

    func open(_ conversation: ConversationKey, account: Int64?) {
        pending = conversation
        self.account = account
        serial += 1
    }

    /// The chat to open for `signedIn`, once; nil when it belongs to another account.
    func take(signedIn: Int64?) -> ConversationKey? {
        defer { clear() }
        guard let route = pending, signedIn != nil else { return nil }
        if let owner = account, owner != signedIn { return nil }
        return route
    }

    /// The session ended: a tap of it opens nothing for the next one.
    func clear() {
        pending = nil
        account = nil
    }
}

/// Whether the user lets the app show notifications.
enum NotificationAuthorization: Equatable, Sendable {
    case notDetermined
    case denied
    case allowed
}

/// The system's notification permission (`UNUserNotificationCenter` in the app).
protocol NotificationAuthorizing: Sendable {
    func status() async -> NotificationAuthorization
    /// Shows the system question; true when the user allowed notifications.
    func request() async -> Bool
}

/// Nothing is asked (unit tests, UI tests, previews).
struct NoNotificationAuthorization: NotificationAuthorizing {
    func status() async -> NotificationAuthorization { .denied }
    func request() async -> Bool { false }
}

/// Decision P: the notification permission is asked once, after sign-in (the user knows by then
/// what the app is for); while it is allowed, every sign-in asks APNs for this device's token, which
/// `PushTokenRegistrar` registers with the server.
@MainActor
final class NotificationPermission {
    private let authorization: any NotificationAuthorizing
    private let registerForRemote: @MainActor () -> Void
    private var asked = false

    init(authorization: any NotificationAuthorizing, registerForRemote: @escaping @MainActor () -> Void) {
        self.authorization = authorization
        self.registerForRemote = registerForRemote
    }

    func signedIn() async {
        var status = await authorization.status()
        if status == .notDetermined, !asked {
            asked = true
            status = await authorization.request() ? .allowed : .denied
        }
        if status == .allowed { registerForRemote() }
    }
}
