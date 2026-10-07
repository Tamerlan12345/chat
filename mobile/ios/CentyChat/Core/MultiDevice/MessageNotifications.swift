import Foundation
import UserNotifications

/// One local notification about a new message.
public struct MessageAlert: Equatable, Sendable {
    public let conversation: ConversationKey
    public let messageId: Int64
    public let title: String
    public let body: String

    public init(conversation: ConversationKey, messageId: Int64, title: String, body: String) {
        self.conversation = conversation
        self.messageId = messageId
        self.title = title
        self.body = body
    }

    public var threadIdentifier: String { MessageAlertPolicy.threadIdentifier(for: conversation) }
    public var identifier: String { MessageAlertPolicy.identifier(forMessage: messageId) }
}

/// When this device shows a banner / local notification about a message (`multi-device.md` §5, §8).
public enum MessageAlertPolicy {
    /// `<conversationType>-<targetId>` — the APNs `thread-id` of the same conversation.
    public static func threadIdentifier(for conversation: ConversationKey) -> String {
        "\(conversation.type.rawValue)-\(conversation.targetId)"
    }

    public static func identifier(forMessage messageId: Int64) -> String {
        "m-\(messageId)"
    }

    /// The conversation as the current user sees it: a channel, or the colleague of a direct dialog.
    public static func conversation(of message: Message, currentUserId: Int64?) -> ConversationKey {
        switch message.conversationType {
        case .channel:
            return ConversationKey(type: .channel, targetId: message.targetId)
        case .direct:
            let partner = message.senderId == currentUserId ? message.targetId : message.senderId
            return ConversationKey(type: .direct, targetId: partner)
        }
    }

    /// The server's `notify` decides; without it (an older server) the old local rule:
    /// not my own message, the conversation is not open here, «Не беспокоить» is off.
    public static func shouldAlert(
        message: Message,
        notify: Bool?,
        currentUserId: Int64?,
        visibleConversation: ConversationKey?,
        isDndEnabled: Bool
    ) -> Bool {
        if let notify { return notify }
        guard message.senderId != currentUserId, !isDndEnabled else { return false }
        return conversation(of: message, currentUserId: currentUserId) != visibleConversation
    }

    /// A message push that arrives while the app is open (the socket just connected) is not
    /// shown when the message is already known or its conversation is open (`push.md` §5).
    public static func shouldPresentMessagePush(
        conversation: ConversationKey,
        messageId: Int64,
        isKnownMessage: Bool,
        visibleConversation: ConversationKey?
    ) -> Bool {
        !isKnownMessage && conversation != visibleConversation
    }
}

/// The system notification centre behind a protocol, so tests can record what would be shown.
public protocol LocalNotificationCenter: Sendable {
    func post(_ alert: MessageAlert) async
    /// Removes delivered notifications of one conversation (by thread identifier).
    func removeDelivered(threadIdentifier: String) async
    /// Removes the delivered notification of one message (deleted, cancelled).
    func removeDelivered(identifier: String) async
    /// Removes every delivered notification of the app (the session ended).
    func removeAllDelivered() async
}

public extension LocalNotificationCenter {
    func removeAllDelivered() async {}
}

/// Shows nothing: unit tests and previews.
public struct SilentNotificationCenter: LocalNotificationCenter {
    public init() {}
    public func post(_ alert: MessageAlert) async {}
    public func removeDelivered(threadIdentifier: String) async {}
    public func removeDelivered(identifier: String) async {}
}

/// `UNUserNotificationCenter`. Shows nothing until the user allowed notifications.
public struct UserNotificationCenterBridge: LocalNotificationCenter {
    public init() {}

    public func post(_ alert: MessageAlert) async {
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.sound = .default
        content.threadIdentifier = alert.threadIdentifier
        content.userInfo = [
            "type": "message",
            "conversationType": alert.conversation.type.rawValue,
            "targetId": alert.conversation.targetId,
            "messageId": alert.messageId,
        ]
        let request = UNNotificationRequest(identifier: alert.identifier, content: content, trigger: nil)
        do {
            try await UNUserNotificationCenter.current().add(request)
        } catch {
            Log.chat.error("Local notification failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    public func removeDelivered(threadIdentifier: String) async {
        let center = UNUserNotificationCenter.current()
        let identifiers = await center.deliveredNotifications()
            .filter { $0.request.content.threadIdentifier == threadIdentifier }
            .map(\.request.identifier)
        guard !identifiers.isEmpty else { return }
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    public func removeDelivered(identifier: String) async {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [identifier])
    }

    /// Asks once for alerts, sounds and badges; the UI decides when.
    public static func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }
}

/// The system's notification permission (decision P: asked once, after sign-in).
struct UserNotificationAuthorization: NotificationAuthorizing {
    func status() async -> NotificationAuthorization {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .notDetermined: return .notDetermined
        case .authorized, .provisional, .ephemeral: return .allowed
        case .denied: return .denied
        @unknown default: return .denied
        }
    }

    func request() async -> Bool {
        await UserNotificationCenterBridge.requestAuthorization()
    }
}
