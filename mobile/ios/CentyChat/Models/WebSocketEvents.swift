import Foundation

// MARK: - Client to Server WebSocket Messages

/// The device fields of the `auth` frame (`multi-device.md` §3). All optional on the wire.
public struct AuthHandshake: Sendable, Equatable {
    /// Same id as in `/api/auth/knock` and the push-token registration; omitted when invalid.
    public var deviceId: String?
    public var platform: String
    /// `away` when the socket connects in the background.
    public var presence: PresenceState
    /// The chat open in the foreground; never sent while away.
    public var viewing: ConversationKey?

    public init(deviceId: String? = nil, platform: String = "ios", presence: PresenceState = .online, viewing: ConversationKey? = nil) {
        self.deviceId = deviceId
        self.platform = platform
        self.presence = presence
        self.viewing = viewing
    }

    /// `[A-Za-z0-9._:-]{1,128}`.
    public static func isValidDeviceId(_ id: String) -> Bool {
        guard (1...128).contains(id.count) else { return false }
        return id.unicodeScalars.allSatisfy { scalar in
            switch scalar {
            case "A"..."Z", "a"..."z", "0"..."9", ".", "_", ":", "-": return true
            default: return false
            }
        }
    }

    var fields: [String: Any] {
        var dict: [String: Any] = ["platform": platform, "presence": presence.rawValue]
        if let deviceId, Self.isValidDeviceId(deviceId) {
            dict["device_id"] = deviceId
        }
        if presence == .online, let viewing {
            dict["viewing"] = ["conversationType": viewing.type.rawValue, "targetId": viewing.targetId]
        }
        return dict
    }
}

/// The automatic presence of this socket: the only two values a client sends (`presence` frame).
public enum PresenceState: String, Sendable, Equatable {
    case online
    case away
}

public enum WSClientMessage: Sendable {
    /// Older call sites send only the token; the realtime client adds the device fields.
    case auth(token: String, handshake: AuthHandshake? = nil)
    /// `viewing {conversationType, targetId}`; nil — no chat open (`conversationType: null`).
    case viewing(ConversationKey?)
    /// Presence with the custom status always present: nil clears it (`customStatus: null`).
    case presenceWithCustomStatus(state: PresenceState, customStatus: String?)
    case sendMessage(conversationType: ConversationType, targetId: Int64, text: String, msgType: MessageType = .text, replyToId: Int64? = nil, metadata: MessageMetadata? = nil)
    case editMessage(messageId: Int64, text: String)
    case deleteMessage(messageId: Int64)
    case markRead(conversationType: ConversationType, targetId: Int64)
    case typing(conversationType: ConversationType, targetId: Int64, isTyping: Bool)
    case presence(state: String, customStatus: String?)
    case setDnd(enabled: Bool, customStatus: String?)
    case wakeSend(targetUserId: Int64)
    case callOffer(targetUserId: Int64)
    case callAnswer(targetUserId: Int64)
    case callRejected(targetUserId: Int64, reason: String?)
    case callEnd(targetUserId: Int64, reason: String?)
    case iceCandidate(targetUserId: Int64, candidate: [String: AnySendable])
    
    public func toJSONData() -> Data? {
        var dict: [String: Any] = [:]
        
        switch self {
        case .auth(let token, let handshake):
            dict = handshake?.fields ?? [:]
            dict["type"] = "auth"
            dict["token"] = token

        case .viewing(let conversation):
            dict = ["type": "viewing"]
            if let conversation {
                dict["conversationType"] = conversation.type.rawValue
                dict["targetId"] = conversation.targetId
            } else {
                dict["conversationType"] = NSNull()
            }

        case .presenceWithCustomStatus(let state, let customStatus):
            dict = ["type": "presence", "state": state.rawValue, "customStatus": customStatus.map { $0 as Any } ?? NSNull()]

        case .sendMessage(let convType, let targetId, let text, let msgType, let replyToId, let metadata):
            dict = [
                "type": "send_message",
                "conversationType": convType.rawValue,
                "targetId": targetId,
                "text": text,
                "msgType": msgType.rawValue
            ]
            if let replyToId = replyToId {
                dict["replyToId"] = replyToId
            }
            if let metadata = metadata {
                var metaDict: [String: Any] = [:]
                if let fId = metadata.fileId { metaDict["file_id"] = fId }
                if let fName = metadata.fileName { metaDict["file_name"] = fName }
                if let fSize = metadata.fileSize { metaDict["size"] = fSize }
                if let fMime = metadata.mimeType { metaDict["mime_type"] = fMime }
                if let fUrl = metadata.url { metaDict["url"] = fUrl }
                dict["metadata"] = metaDict
            }
            
        case .editMessage(let messageId, let text):
            dict = ["type": "edit_message", "messageId": messageId, "text": text]
            
        case .deleteMessage(let messageId):
            dict = ["type": "delete_message", "messageId": messageId]
            
        case .markRead(let convType, let targetId):
            dict = ["type": "mark_read", "conversationType": convType.rawValue, "targetId": targetId]
            
        case .typing(let convType, let targetId, let isTyping):
            dict = ["type": "typing", "conversationType": convType.rawValue, "targetId": targetId, "isTyping": isTyping]
            
        case .presence(let state, let customStatus):
            dict = ["type": "presence", "state": state]
            if let customStatus = customStatus {
                dict["customStatus"] = customStatus
            }
            
        case .setDnd(let enabled, let customStatus):
            dict = ["type": "set_dnd", "enabled": enabled]
            if let customStatus = customStatus {
                dict["customStatus"] = customStatus
            }
            
        case .wakeSend(let targetUserId):
            dict = ["type": "wake_send", "targetUserId": targetUserId]
            
        case .callOffer(let targetUserId):
            dict = ["type": "call_offer", "targetUserId": targetUserId]
            
        case .callAnswer(let targetUserId):
            dict = ["type": "call_answer", "targetUserId": targetUserId]
            
        case .callRejected(let targetUserId, let reason):
            dict = ["type": "call_rejected", "targetUserId": targetUserId]
            if let reason = reason { dict["reason"] = reason }
            
        case .callEnd(let targetUserId, let reason):
            dict = ["type": "call_end", "targetUserId": targetUserId]
            if let reason = reason { dict["reason"] = reason }
            
        case .iceCandidate(let targetUserId, let candidate):
            dict = ["type": "ice_candidate", "targetUserId": targetUserId, "candidate": candidate.mapValues { $0.value }]
        }
        
        return try? JSONSerialization.data(withJSONObject: dict, options: [])
    }
}

/// Sendable wrapper for JSON values in dictionaries
public struct AnySendable: @unchecked Sendable {
    public let value: Any
    public init(_ value: Any) { self.value = value }
}

// MARK: - Server to Client WebSocket Events

public enum WSServerEvent: Sendable {
    case authSuccess(user: User)
    case authError(code: String, message: String)
    case wakeState(targetUserId: Int64?, at: Int64?, retryAt: Int64)
    case serverDisconnect(reason: String)
    /// `notify`: show a banner / local notification on this socket (`multi-device.md` §5); nil — an older server.
    case newMessage(message: Message, notify: Bool?)
    /// Read on another device of mine: zero the unread counter, dismiss its notifications.
    case conversationRead(conversation: ConversationKey, byUserId: Int64, messageIds: [Int64], lastReadId: Int64?)
    /// The author cancelled an unsent message (`cancel_message`); `messageId` when it was stored.
    case messageCancelled(clientMsgId: String, messageId: Int64?)
    case messageStatusUpdated(messageId: Int64, status: DeliveryStatus, userId: Int64?, timestamp: String?)
    case messagesRead(byUserId: Int64, messageIds: [Int64])
    case messageUpdated(messageId: Int64, text: String, updatedAt: Date?)
    case messageDeleted(messageId: Int64, conversationType: ConversationType?, targetId: Int64?)
    case userTyping(userId: Int64, userName: String, conversationType: ConversationType, targetId: Int64, isTyping: Bool)
    case userStatusChanged(userId: Int64, status: UserStatus, customStatus: String?)
    case userCreated(user: PublicUser)
    case userUpdated(user: PublicUser)
    case channelCreated(channel: Channel)
    case channelDeleted(channelId: Int64)
    case newAnnouncement(announcement: Announcement)
    case announcementAcknowledged(announcementId: String, userId: Int64, userName: String)
    case callOffer(targetUserId: Int64, senderId: Int64, senderName: String)
    case callAnswer(targetUserId: Int64, senderId: Int64, senderName: String)
    case callRejected(targetUserId: Int64, senderId: Int64, senderName: String, reason: String?)
    /// `targetUserId` is absent when the server ends a call because a peer's connection dropped.
    case callEnd(targetUserId: Int64?, senderId: Int64, senderName: String, reason: String?)
    case callDenied(reason: String)
    case callUnavailable(targetUserId: Int64, reason: String)
    /// Relayed WebRTC signalling. Calls use the server audio relay, so it is parsed and ignored.
    case iceCandidate(targetUserId: Int64, senderId: Int64, senderName: String)
    case wakeRing(fromUserId: Int64, fromName: String, at: Int64)
    case wakeSent(targetUserId: Int64, at: Int64, retryAt: Int64)
    case wakeError(code: String, message: String?)
    case serverError(context: String?, message: String?, originalText: String?)
    case unknown(type: String, rawJson: String)
    
    public static func parse(from data: Data) -> WSServerEvent? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return nil
        }
        
        let decoder = JSONDecoder()
        
        switch type {
        case "auth_success":
            if let userDict = json["user"],
               let userData = try? JSONSerialization.data(withJSONObject: userDict),
               let user = try? decoder.decode(User.self, from: userData) {
                return .authSuccess(user: user)
            }
            return nil
            
        case "auth_error":
            let code = json["code"] as? String ?? "UNKNOWN"
            let message = json["message"] as? String ?? String(localized: "Ошибка авторизации")
            return .authError(code: code, message: message)
            
        case "wake_state":
            let targetUserId = (json["targetUserId"] as? NSNumber)?.int64Value
            let at = (json["at"] as? NSNumber)?.int64Value
            let retryAt = (json["retryAt"] as? NSNumber)?.int64Value ?? 0
            return .wakeState(targetUserId: targetUserId, at: at, retryAt: retryAt)
            
        case "server_disconnect":
            let reason = json["reason"] as? String ?? String(localized: "Отключено сервером")
            return .serverDisconnect(reason: reason)
            
        case "new_message", "direct_message", "channel_message":
            if let msgDict = json["message"],
               let msgData = try? JSONSerialization.data(withJSONObject: msgDict),
               let msg = try? decoder.decode(Message.self, from: msgData) {
                return .newMessage(message: msg, notify: json["notify"] as? Bool)
            }
            return nil
            
        case "conversation_read":
            guard let convStr = json["conversationType"] as? String,
                  let conv = ConversationType(rawValue: convStr),
                  let tId = (json["targetId"] as? NSNumber)?.int64Value else { return nil }
            let byUser = (json["byUserId"] as? NSNumber)?.int64Value ?? 0
            let ids = (json["messageIds"] as? [NSNumber])?.map { $0.int64Value } ?? []
            let lastReadId = (json["lastReadId"] as? NSNumber)?.int64Value
            return .conversationRead(
                conversation: ConversationKey(type: conv, targetId: tId),
                byUserId: byUser,
                messageIds: ids,
                lastReadId: lastReadId
            )

        case "message_cancelled":
            guard let clientMsgId = json["client_msg_id"] as? String else { return nil }
            return .messageCancelled(clientMsgId: clientMsgId, messageId: (json["messageId"] as? NSNumber)?.int64Value)

        case "message_status_updated":
            guard let mId = (json["messageId"] as? NSNumber)?.int64Value,
                  let statusStr = json["status"] as? String,
                  let status = DeliveryStatus(rawValue: statusStr) else { return nil }
            let uId = (json["userId"] as? NSNumber)?.int64Value
            let ts = json["timestamp"] as? String
            return .messageStatusUpdated(messageId: mId, status: status, userId: uId, timestamp: ts)
            
        case "messages_read":
            let byUser = (json["byUserId"] as? NSNumber)?.int64Value ?? 0
            let ids = (json["messageIds"] as? [NSNumber])?.map { $0.int64Value } ?? []
            return .messagesRead(byUserId: byUser, messageIds: ids)
            
        case "message_updated":
            if let msgDict = json["message"] as? [String: Any],
               let mId = (msgDict["id"] as? NSNumber)?.int64Value,
               let text = msgDict["text"] as? String {
                let updatedDate = (msgDict["updated_at"] as? String).flatMap { DateParser.parse($0) }
                return .messageUpdated(messageId: mId, text: text, updatedAt: updatedDate)
            }
            return nil
            
        case "message_deleted":
            guard let mId = (json["messageId"] as? NSNumber)?.int64Value else { return nil }
            let convType = (json["conversationType"] as? String).flatMap { ConversationType(rawValue: $0) }
            let targetId = (json["targetId"] as? NSNumber)?.int64Value
            return .messageDeleted(messageId: mId, conversationType: convType, targetId: targetId)
            
        case "user_typing":
            guard let uId = (json["userId"] as? NSNumber)?.int64Value,
                  let uName = json["userName"] as? String,
                  let convStr = json["conversationType"] as? String,
                  let conv = ConversationType(rawValue: convStr),
                  let tId = (json["targetId"] as? NSNumber)?.int64Value,
                  let isTyping = json["isTyping"] as? Bool else { return nil }
            return .userTyping(userId: uId, userName: uName, conversationType: conv, targetId: tId, isTyping: isTyping)
            
        case "user_status_changed":
            guard let uId = (json["userId"] as? NSNumber ?? json["user_id"] as? NSNumber)?.int64Value,
                  let stStr = json["status"] as? String,
                  let st = UserStatus(rawValue: stStr) else { return nil }
            let customStatus = json["customStatus"] as? String
            return .userStatusChanged(userId: uId, status: st, customStatus: customStatus)
            
        case "user_created":
            if let uDict = json["user"],
               let uData = try? JSONSerialization.data(withJSONObject: uDict),
               let pubUser = try? decoder.decode(PublicUser.self, from: uData) {
                return .userCreated(user: pubUser)
            }
            return nil
            
        case "user_updated":
            if let uDict = json["user"],
               let uData = try? JSONSerialization.data(withJSONObject: uDict),
               let pubUser = try? decoder.decode(PublicUser.self, from: uData) {
                return .userUpdated(user: pubUser)
            }
            return nil
            
        case "channel_created":
            if let cDict = json["channel"],
               let cData = try? JSONSerialization.data(withJSONObject: cDict),
               let channel = try? decoder.decode(Channel.self, from: cData) {
                return .channelCreated(channel: channel)
            }
            return nil
            
        case "channel_deleted":
            if let cId = (json["channelId"] as? NSNumber)?.int64Value {
                return .channelDeleted(channelId: cId)
            }
            return nil
            
        case "new_announcement":
            if let aDict = json["announcement"],
               let aData = try? JSONSerialization.data(withJSONObject: aDict),
               let ann = try? decoder.decode(Announcement.self, from: aData) {
                return .newAnnouncement(announcement: ann)
            }
            return nil
            
        case "announcement_acknowledged":
            let aId = "\(json["announcementId"] ?? "")"
            let uId = (json["userId"] as? NSNumber)?.int64Value ?? 0
            let uName = json["userName"] as? String ?? ""
            return .announcementAcknowledged(announcementId: aId, userId: uId, userName: uName)
            
        case "call_offer":
            guard let tId = (json["targetUserId"] as? NSNumber)?.int64Value,
                  let sId = (json["senderId"] as? NSNumber)?.int64Value,
                  let sName = json["senderName"] as? String else { return nil }
            return .callOffer(targetUserId: tId, senderId: sId, senderName: sName)
            
        case "call_answer":
            guard let tId = (json["targetUserId"] as? NSNumber)?.int64Value,
                  let sId = (json["senderId"] as? NSNumber)?.int64Value,
                  let sName = json["senderName"] as? String else { return nil }
            return .callAnswer(targetUserId: tId, senderId: sId, senderName: sName)
            
        case "call_rejected":
            guard let tId = (json["targetUserId"] as? NSNumber)?.int64Value,
                  let sId = (json["senderId"] as? NSNumber)?.int64Value,
                  let sName = json["senderName"] as? String else { return nil }
            let reason = json["reason"] as? String
            return .callRejected(targetUserId: tId, senderId: sId, senderName: sName, reason: reason)
            
        case "call_end":
            guard let sId = (json["senderId"] as? NSNumber)?.int64Value else { return nil }
            let tId = (json["targetUserId"] as? NSNumber)?.int64Value
            let sName = json["senderName"] as? String ?? ""
            let reason = json["reason"] as? String
            return .callEnd(targetUserId: tId, senderId: sId, senderName: sName, reason: reason)
            
        case "call_denied":
            let reason = json["reason"] as? String ?? String(localized: "Звонок запрещен политикой")
            return .callDenied(reason: reason)
            
        case "call_unavailable":
            let tId = (json["targetUserId"] as? NSNumber)?.int64Value ?? 0
            let reason = json["reason"] as? String ?? String(localized: "Собеседник недоступен")
            return .callUnavailable(targetUserId: tId, reason: reason)
            
        case "ice_candidate":
            guard let tId = (json["targetUserId"] as? NSNumber)?.int64Value,
                  let sId = (json["senderId"] as? NSNumber)?.int64Value else { return nil }
            let sName = json["senderName"] as? String ?? ""
            return .iceCandidate(targetUserId: tId, senderId: sId, senderName: sName)

        case "wake_ring":
            guard let fId = (json["fromUserId"] as? NSNumber)?.int64Value,
                  let fName = json["fromName"] as? String else { return nil }
            let at = (json["at"] as? NSNumber)?.int64Value ?? Int64(Date().timeIntervalSince1970 * 1000)
            return .wakeRing(fromUserId: fId, fromName: fName, at: at)
            
        case "wake_sent":
            guard let tId = (json["targetUserId"] as? NSNumber)?.int64Value else { return nil }
            let at = (json["at"] as? NSNumber)?.int64Value ?? 0
            let retryAt = (json["retryAt"] as? NSNumber)?.int64Value ?? (at + 60_000)
            return .wakeSent(targetUserId: tId, at: at, retryAt: retryAt)
            
        case "wake_error":
            let code = json["code"] as? String ?? "error"
            let message = json["message"] as? String
            return .wakeError(code: code, message: message)
            
        case "error":
            let context = json["context"] as? String
            let msg = json["message"] as? String
            let text = json["text"] as? String
            return .serverError(context: context, message: msg, originalText: text)
            
        default:
            let raw = String(data: data, encoding: .utf8) ?? ""
            return .unknown(type: type, rawJson: raw)
        }
    }
}
