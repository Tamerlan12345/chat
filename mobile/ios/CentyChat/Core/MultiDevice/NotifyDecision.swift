import Foundation

/// Swift port of `mobile/contracts/reference/notify-decision.mjs` (`multi-device.md` §5):
/// who gets a banner, a quiet frame or a push for one new message, and who gets the silent
/// `read` push. Pure: no clock, no randomness, no I/O. Must pass every vector in
/// `mobile/contracts/fixtures/notify/*.json`; change it only together with the reference.
public enum NotifyDecision {
    public static let online = "online"

    /// A chat as one recipient sees it: a channel id, or the colleague in a direct dialog.
    public struct Chat: Codable, Equatable, Sendable {
        public let conversationType: String
        public let targetId: Int64

        public init(conversationType: String, targetId: Int64) {
            self.conversationType = conversationType
            self.targetId = targetId
        }
    }

    /// One live socket of the recipient.
    public struct Socket: Codable, Equatable, Sendable {
        public let id: String
        public let deviceId: String?
        public let presence: String
        public let viewing: Chat?

        public init(id: String, deviceId: String?, presence: String, viewing: Chat?) {
            self.id = id
            self.deviceId = deviceId
            self.presence = presence
            self.viewing = viewing
        }
    }

    /// A device with a push token able to show a message notification (id = its `device_id`).
    public struct PushDevice: Codable, Equatable, Sendable {
        public let id: String

        public init(id: String) {
            self.id = id
        }
    }

    /// The message as the server stores it (direct: `targetId` is the addressee).
    public struct MessageRef: Codable, Equatable, Sendable {
        public let conversationType: String
        public let targetId: Int64
        public let senderId: Int64

        public init(conversationType: String, targetId: Int64, senderId: Int64) {
            self.conversationType = conversationType
            self.targetId = targetId
            self.senderId = senderId
        }
    }

    public struct MessageInput: Codable, Equatable, Sendable {
        public let recipientId: Int64
        public let dnd: Bool
        public let message: MessageRef
        public let sockets: [Socket]
        public let pushDevices: [PushDevice]

        public init(recipientId: Int64, dnd: Bool = false, message: MessageRef, sockets: [Socket] = [], pushDevices: [PushDevice] = []) {
            self.recipientId = recipientId
            self.dnd = dnd
            self.message = message
            self.sockets = sockets
            self.pushDevices = pushDevices
        }

        enum CodingKeys: String, CodingKey {
            case recipientId, dnd, message, sockets, pushDevices
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            recipientId = try container.decode(Int64.self, forKey: .recipientId)
            dnd = try container.decodeIfPresent(Bool.self, forKey: .dnd) ?? false
            message = try container.decode(MessageRef.self, forKey: .message)
            sockets = try container.decodeIfPresent([Socket].self, forKey: .sockets) ?? []
            pushDevices = try container.decodeIfPresent([PushDevice].self, forKey: .pushDevices) ?? []
        }
    }

    public enum Reason: String, Codable, Equatable, Sendable {
        case own
        case dnd
        case viewing
        /// Calls only: no socket would ring and there is nothing to wake by push.
        case unreachable
    }

    /// The caller of an incoming call (`multi-device.md` §7).
    public struct CallRef: Codable, Equatable, Sendable {
        public let callerId: Int64

        public init(callerId: Int64) {
            self.callerId = callerId
        }
    }

    public struct CallInput: Codable, Equatable, Sendable {
        public let recipientId: Int64
        public let dnd: Bool
        public let call: CallRef
        public let sockets: [Socket]
        /// Devices able to ring: Android FCM, iOS PushKit VoIP.
        public let pushDevices: [PushDevice]

        public init(recipientId: Int64, dnd: Bool = false, call: CallRef, sockets: [Socket] = [], pushDevices: [PushDevice] = []) {
            self.recipientId = recipientId
            self.dnd = dnd
            self.call = call
            self.sockets = sockets
            self.pushDevices = pushDevices
        }

        enum CodingKeys: String, CodingKey {
            case recipientId, dnd, call, sockets, pushDevices
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            recipientId = try container.decode(Int64.self, forKey: .recipientId)
            dnd = try container.decodeIfPresent(Bool.self, forKey: .dnd) ?? false
            call = try container.decode(CallRef.self, forKey: .call)
            sockets = try container.decodeIfPresent([Socket].self, forKey: .sockets) ?? []
            pushDevices = try container.decodeIfPresent([PushDevice].self, forKey: .pushDevices) ?? []
        }
    }

    public struct CallOutcome: Equatable, Sendable {
        /// nil — the call rings somewhere.
        public let reason: Reason?
        /// Device ids that get a ring push; in `pushDevices` order.
        public let push: [String]
        /// Socket ids that ring on the `call_offer` frame; in `sockets` order.
        public let ring: [String]
        /// Socket ids that get the frame but are woken by push.
        public let quiet: [String]

        public init(reason: Reason?, push: [String], ring: [String], quiet: [String]) {
            self.reason = reason
            self.push = push
            self.ring = ring
            self.quiet = quiet
        }
    }

    public struct MessageOutcome: Equatable, Sendable {
        /// nil — notify.
        public let reason: Reason?
        /// Device ids that get a push; in `pushDevices` order.
        public let push: [String]
        /// Socket ids whose frame carries `notify: true`; in `sockets` order.
        public let banner: [String]
        /// Socket ids that get the frame with `notify: false`.
        public let quiet: [String]

        public init(reason: Reason?, push: [String], banner: [String], quiet: [String]) {
            self.reason = reason
            self.push = push
            self.banner = banner
            self.quiet = quiet
        }
    }

    // MARK: - Shared core (mirrors the BEGIN/END block of the reference)

    /// The chat from the recipient's point of view: a channel is its id, a direct dialog the colleague.
    public static func chatOf(_ message: MessageRef, recipientId: Int64) -> Chat {
        if message.conversationType == "channel" {
            return Chat(conversationType: "channel", targetId: message.targetId)
        }
        let target = message.senderId == recipientId ? message.targetId : message.senderId
        return Chat(conversationType: "direct", targetId: target)
    }

    /// «Смотрит этот чат» — only a foreground (online) socket counts.
    public static func isViewing(_ socket: Socket, _ chat: Chat) -> Bool {
        guard socket.presence == online, let viewing = socket.viewing else { return false }
        return viewing.conversationType == chat.conversationType && viewing.targetId == chat.targetId
    }

    static func onlineDeviceIds(_ sockets: [Socket]) -> Set<String> {
        var ids = Set<String>()
        for socket in sockets where socket.presence == online {
            if let deviceId = socket.deviceId, !deviceId.isEmpty {
                ids.insert(deviceId)
            }
        }
        return ids
    }

    public static func decideMessageNotification(_ input: MessageInput) -> MessageOutcome {
        func silent(_ reason: Reason) -> MessageOutcome {
            MessageOutcome(reason: reason, push: [], banner: [], quiet: input.sockets.map(\.id))
        }
        if input.message.senderId == input.recipientId { return silent(.own) }
        if input.dnd { return silent(.dnd) }
        let chat = chatOf(input.message, recipientId: input.recipientId)
        if input.sockets.contains(where: { isViewing($0, chat) }) { return silent(.viewing) }

        let withPush = Set(input.pushDevices.map(\.id))
        let onlineDevices = onlineDeviceIds(input.sockets)
        var banner: [String] = []
        var quiet: [String] = []
        for socket in input.sockets {
            // A background socket on a device with push is woken by the push; without push — a banner.
            let hasPush = socket.deviceId.map { !$0.isEmpty && withPush.contains($0) } ?? false
            if socket.presence == online || !hasPush {
                banner.append(socket.id)
            } else {
                quiet.append(socket.id)
            }
        }
        let push = input.pushDevices.filter { !onlineDevices.contains($0.id) }.map(\.id)
        return MessageOutcome(reason: nil, push: push, banner: banner, quiet: quiet)
    }

    /// An incoming call always rings — an open chat does not silence it. Every socket gets the
    /// `call_offer` frame; `ring` are the sockets that ring on it (foreground, or background on a
    /// device without push), `quiet` are background sockets on a device with push (the push wakes
    /// them). `push` goes to devices with no foreground socket. Nothing to ring or wake — `unreachable`.
    public static func decideCallNotification(_ input: CallInput) -> CallOutcome {
        func silent(_ reason: Reason) -> CallOutcome {
            CallOutcome(reason: reason, push: [], ring: [], quiet: input.sockets.map(\.id))
        }
        if input.call.callerId == input.recipientId { return silent(.own) }
        if input.dnd { return silent(.dnd) }
        let withPush = Set(input.pushDevices.map(\.id))
        let onlineDevices = onlineDeviceIds(input.sockets)
        var ring: [String] = []
        var quiet: [String] = []
        for socket in input.sockets {
            let hasPush = socket.deviceId.map { !$0.isEmpty && withPush.contains($0) } ?? false
            if socket.presence == online || !hasPush {
                ring.append(socket.id)
            } else {
                quiet.append(socket.id)
            }
        }
        let push = input.pushDevices.filter { !onlineDevices.contains($0.id) }.map(\.id)
        if ring.isEmpty && push.isEmpty {
            return CallOutcome(reason: .unreachable, push: push, ring: ring, quiet: quiet)
        }
        return CallOutcome(reason: nil, push: push, ring: ring, quiet: quiet)
    }

    /// Read on one device: the silent `read` push goes to devices with push and no foreground socket.
    public static func decideReadDismissal(sockets: [Socket], pushDevices: [PushDevice]) -> [String] {
        let onlineDevices = onlineDeviceIds(sockets)
        return pushDevices.filter { !onlineDevices.contains($0.id) }.map(\.id)
    }
}
