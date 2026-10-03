import Foundation

/// A push as the app receives it (`push.md` §4): only ids, never text. APNs carries numbers at
/// the top level of `userInfo`; FCM `data` carries strings — both are accepted. Unknown types
/// and unknown fields are ignored.
public enum PushPayload: Equatable, Sendable {
    /// A new message; `conversation` is from the recipient's point of view.
    case message(conversation: ConversationKey, messageId: Int64)
    /// Read on another device: dismiss the conversation's notifications, zero its unread.
    case read(conversation: ConversationKey)
    /// An incoming call (PushKit). Call handling is unchanged here.
    case call(callerId: Int64, callId: String?)

    public static func parse(_ userInfo: [AnyHashable: Any]) -> PushPayload? {
        guard let type = userInfo["type"] as? String else { return nil }
        switch type {
        case "message":
            guard let conversation = conversation(in: userInfo),
                  let messageId = int64(userInfo["messageId"]) else { return nil }
            return .message(conversation: conversation, messageId: messageId)
        case "read":
            guard let conversation = conversation(in: userInfo) else { return nil }
            return .read(conversation: conversation)
        case "call":
            guard let callerId = int64(userInfo["callerId"]) else { return nil }
            return .call(callerId: callerId, callId: userInfo["callId"] as? String)
        default:
            return nil
        }
    }

    public var conversation: ConversationKey? {
        switch self {
        case .message(let conversation, _), .read(let conversation): conversation
        case .call: nil
        }
    }

    private static func conversation(in userInfo: [AnyHashable: Any]) -> ConversationKey? {
        guard let raw = userInfo["conversationType"] as? String,
              let type = ConversationType(rawValue: raw),
              let targetId = int64(userInfo["targetId"]), targetId > 0 else { return nil }
        return ConversationKey(type: type, targetId: targetId)
    }

    private static func int64(_ value: Any?) -> Int64? {
        switch value {
        case let number as NSNumber:
            return number.int64Value
        case let text as String:
            return Int64(text)
        default:
            return nil
        }
    }
}
