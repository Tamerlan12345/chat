import Foundation

/// The client delivery model of `mobile/contracts/delivery-state.md` §3. A value: one reducer step
/// works on its own copy and never changes the input. `json` / `init(json:)` are the contract's
/// projection (the vectors compare it); `Msg.record` is the platform's extra — the whole server
/// record for the screen — and is not part of the projection.
public struct DeliveryState: Sendable, Equatable {
    public static let offline = "offline"
    public static let online = "online"

    public var me: Int64?
    public var connection: String = DeliveryState.offline
    public var visible: String?
    public var sync = SyncState()
    public var seq: Int64 = 0
    public var outbox: [OutboxEntry] = []
    public var ops: [DeliveryOp] = []
    /// Conversation key → messages by ascending id; never an empty list.
    public var messages: [String: [Msg]] = [:]
    public var unread: [String: Int64] = [:]
    public var sendLog: [Int64] = []
    public var opsLog: [Int64] = []
    public var wakeAt: Int64?
    public var cancelled: [String] = []

    public init(me: Int64? = nil) {
        self.me = me
    }

    public var json: JSONValue {
        .object([
            "me": .orNull(me),
            "connection": .string(connection),
            "visible": .orNull(visible),
            "sync": sync.json,
            "seq": .int(seq),
            "outbox": .array(outbox.map(\.json)),
            "ops": .array(ops.map(\.json)),
            "messages": .object(messages.mapValues { .array($0.map(\.json)) }),
            "unread": .object(unread.mapValues(JSONValue.int)),
            "sendLog": .array(sendLog.map(JSONValue.int)),
            "opsLog": .array(opsLog.map(JSONValue.int)),
            "wake_at": .orNull(wakeAt),
            "cancelled": .array(cancelled.map(JSONValue.string)),
        ])
    }

    public init(json: JSONValue) {
        me = json["me"]?.int64
        connection = json["connection"]?.string ?? DeliveryState.offline
        visible = json["visible"]?.string
        sync = json["sync"].map(SyncState.init(json:)) ?? SyncState()
        seq = json["seq"]?.int64 ?? 0
        outbox = (json["outbox"]?.array ?? []).map(OutboxEntry.init(json:))
        ops = (json["ops"]?.array ?? []).map(DeliveryOp.init(json:))
        var messages: [String: [Msg]] = [:]
        for (key, list) in json["messages"]?.object ?? [:] {
            messages[key] = (list.array ?? []).map(Msg.init(json:))
        }
        self.messages = messages
        var unread: [String: Int64] = [:]
        for (key, count) in json["unread"]?.object ?? [:] {
            if let count = count.int64 { unread[key] = count }
        }
        self.unread = unread
        sendLog = (json["sendLog"]?.array ?? []).compactMap(\.int64)
        opsLog = (json["opsLog"]?.array ?? []).compactMap(\.int64)
        wakeAt = json["wake_at"]?.int64
        cancelled = (json["cancelled"]?.array ?? []).compactMap(\.string)
    }
}

public struct SyncState: Sendable, Equatable {
    public var cursor: String?
    public var running = false
    public var bootstrap = false
    public var chain: Int64 = 0

    public init(cursor: String? = nil) {
        self.cursor = cursor
    }

    var json: JSONValue {
        .object([
            "cursor": .orNull(cursor),
            "running": .bool(running),
            "bootstrap": .bool(bootstrap),
            "chain": .int(chain),
        ])
    }

    init(json: JSONValue) {
        cursor = json["cursor"]?.string
        running = json["running"]?.bool ?? false
        bootstrap = json["bootstrap"]?.bool ?? false
        chain = json["chain"]?.int64 ?? 0
    }
}

/// Why an outbox entry is `failed` (§3.1).
public struct DeliveryFailure: Sendable, Equatable, Codable {
    public static let rejected = "rejected"
    public static let maxAttempts = "max_attempts"

    public var reason: String
    public var code: String?
    public var message: String?

    var json: JSONValue {
        .object(["reason": .string(reason), "code": .orNull(code), "message": .orNull(message)])
    }

    init(reason: String, code: String?, message: String?) {
        self.reason = reason
        self.code = code
        self.message = message
    }

    init(json: JSONValue) {
        reason = json["reason"]?.string ?? DeliveryFailure.rejected
        code = json["code"]?.string
        message = json["message"]?.string
    }
}

/// An outbox entry (§3.1).
public struct OutboxEntry: Sendable, Equatable, Identifiable {
    public static let queued = "queued"
    public static let sending = "sending"
    public static let failed = "failed"
    public static let ws = "ws"
    public static let http = "http"

    public var id: String { clientMsgId }

    public var clientMsgId: String
    public var conversation: String
    public var seq: Int64
    public var text: String
    public var msgType: String = "text"
    public var replyToId: Int64?
    /// `{ "file_id": 42, … }` or nil.
    public var metadata: JSONValue?
    public var state: String = OutboxEntry.queued
    public var attempts: Int64 = 0
    public var failures: Int64 = 0
    public var maybeStored = false
    public var transport: String?
    public var ackDeadline: Int64?
    public var nextAttemptAt: Int64?
    public var failure: DeliveryFailure?
    public var pendingEdit: String?
    public var pendingDelete = false

    public init(clientMsgId: String, conversation: String, seq: Int64, text: String, msgType: String = "text", replyToId: Int64? = nil, metadata: JSONValue? = nil) {
        self.clientMsgId = clientMsgId
        self.conversation = conversation
        self.seq = seq
        self.text = text
        self.msgType = msgType
        self.replyToId = replyToId
        self.metadata = metadata
    }

    var json: JSONValue {
        .object([
            "client_msg_id": .string(clientMsgId),
            "conversation": .string(conversation),
            "seq": .int(seq),
            "text": .string(text),
            "msgType": .string(msgType),
            "reply_to_id": .orNull(replyToId),
            "metadata": metadata ?? .null,
            "state": .string(state),
            "attempts": .int(attempts),
            "failures": .int(failures),
            "maybe_stored": .bool(maybeStored),
            "transport": .orNull(transport),
            "ack_deadline": .orNull(ackDeadline),
            "next_attempt_at": .orNull(nextAttemptAt),
            "failure": failure?.json ?? .null,
            "pending_edit": .orNull(pendingEdit),
            "pending_delete": .bool(pendingDelete),
        ])
    }

    init(json: JSONValue) {
        clientMsgId = json["client_msg_id"]?.string ?? ""
        conversation = json["conversation"]?.string ?? ""
        seq = json["seq"]?.int64 ?? 0
        text = json["text"]?.string ?? ""
        msgType = json["msgType"]?.string ?? "text"
        replyToId = json["reply_to_id"]?.int64
        metadata = json["metadata"].flatMap { $0.isNull ? nil : $0 }
        state = json["state"]?.string ?? OutboxEntry.queued
        attempts = json["attempts"]?.int64 ?? 0
        failures = json["failures"]?.int64 ?? 0
        maybeStored = json["maybe_stored"]?.bool ?? false
        transport = json["transport"]?.string
        ackDeadline = json["ack_deadline"]?.int64
        nextAttemptAt = json["next_attempt_at"]?.int64
        failure = json["failure"].flatMap { $0.object == nil ? nil : DeliveryFailure(json: $0) }
        pendingEdit = json["pending_edit"]?.string
        pendingDelete = json["pending_delete"]?.bool ?? false
    }
}

/// An operation on a confirmed message, or a revocation by key (§3.2).
public struct DeliveryOp: Sendable, Equatable {
    public static let edit = "edit"
    public static let delete = "delete"
    public static let cancel = "cancel"

    public var op: String
    public var messageId: Int64?
    public var clientMsgId: String?
    public var text: String?
    public var state: String = OutboxEntry.queued
    public var attempts: Int64 = 0
    public var failures: Int64 = 0
    public var ackDeadline: Int64?
    public var nextAttemptAt: Int64?

    init(op: String, messageId: Int64?, clientMsgId: String? = nil, text: String?) {
        self.op = op
        self.messageId = messageId
        self.clientMsgId = clientMsgId
        self.text = text
    }

    var json: JSONValue {
        .object([
            "op": .string(op),
            "message_id": .orNull(messageId),
            "client_msg_id": .orNull(clientMsgId),
            "text": .orNull(text),
            "state": .string(state),
            "attempts": .int(attempts),
            "failures": .int(failures),
            "ack_deadline": .orNull(ackDeadline),
            "next_attempt_at": .orNull(nextAttemptAt),
        ])
    }

    init(json: JSONValue) {
        op = json["op"]?.string ?? ""
        messageId = json["message_id"]?.int64
        clientMsgId = json["client_msg_id"]?.string
        text = json["text"]?.string
        state = json["state"]?.string ?? OutboxEntry.queued
        attempts = json["attempts"]?.int64 ?? 0
        failures = json["failures"]?.int64 ?? 0
        ackDeadline = json["ack_deadline"]?.int64
        nextAttemptAt = json["next_attempt_at"]?.int64
    }
}

/// A message in `messages` (§3.3). `record` is the whole server record the screen draws from.
public struct Msg: Sendable, Equatable {
    public var id: Int64
    public var clientMsgId: String?
    public var senderId: Int64
    public var text: String
    public var type: String
    public var replyToId: Int64?
    public var metadataJson: String?
    public var createdAt: String?
    public var updatedAt: String?
    public var isDeleted: Int
    public var status: String?
    public var record: JSONObject?

    var json: JSONValue {
        var object: JSONObject = [
            "id": .int(id),
            "client_msg_id": .orNull(clientMsgId),
            "sender_id": .int(senderId),
            "text": .string(text),
            "type": .string(type),
            "reply_to_id": .orNull(replyToId),
            "metadata_json": .orNull(metadataJson),
            "updated_at": .orNull(updatedAt),
            "is_deleted": .int(Int64(isDeleted)),
            "status": .orNull(status),
        ]
        // A record without created_at has none in the reference either (JSON drops undefined).
        if let createdAt { object["created_at"] = .string(createdAt) }
        return .object(object)
    }

    init(id: Int64, clientMsgId: String?, senderId: Int64, text: String, type: String, replyToId: Int64?, metadataJson: String?, createdAt: String?, updatedAt: String?, isDeleted: Int, status: String?, record: JSONObject?) {
        self.id = id
        self.clientMsgId = clientMsgId
        self.senderId = senderId
        self.text = text
        self.type = type
        self.replyToId = replyToId
        self.metadataJson = metadataJson
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.isDeleted = isDeleted
        self.status = status
        self.record = record
    }

    init(json: JSONValue) {
        id = json["id"]?.int64 ?? 0
        clientMsgId = json["client_msg_id"]?.string
        senderId = json["sender_id"]?.int64 ?? 0
        text = json["text"]?.string ?? ""
        type = json["type"]?.string ?? "text"
        replyToId = json["reply_to_id"]?.int64
        metadataJson = json["metadata_json"]?.string
        createdAt = json["created_at"]?.string
        updatedAt = json["updated_at"]?.string
        isDeleted = (json["is_deleted"]?.isTruthy ?? false) ? 1 : 0
        status = json["status"]?.string
        record = json["record"]?.object
    }

    /// The server record of this message as this device knows it now: the stored record with the
    /// merged content (§7.9), the tombstone and this device's delivery status on top.
    public var mergedRecord: JSONObject {
        var merged = record ?? [:]
        for (key, value) in json.object ?? [:] where key != "status" {
            merged[key] = value
        }
        if isDeleted == 1 {
            merged["text"] = ""
            merged["file_original_name"] = .null
        }
        if status == "delivered" || status == "read" {
            merged["delivery_status"] = .orNull(status)
        }
        return merged
    }
}
