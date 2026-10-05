import Foundation

/// A frame from the realtime socket as the delivery engine sees it: every server frame as received,
/// in order, and `closed` whenever a socket goes away (any reason).
public enum DeliveryLinkFrame: Sendable, Equatable {
    case frame(JSONObject)
    case closed
}

/// The authenticated WebSocket as the delivery engine sees it.
public protocol DeliveryLink: Sendable {
    /// Writes a frame on the authenticated socket; false when it was not written (no socket, or not
    /// authenticated yet).
    func send(_ frame: JSONObject) async -> Bool
    /// Drops the socket so it reconnects (a new sync chain re-reads what the model lost).
    func restart() async
    /// The signed-in user while a socket is authenticated right now; nil otherwise.
    func authenticatedUserId() async -> Int64?
}

/// What `GET /api/sync` answered.
public enum SyncOutcome: Sendable, Equatable {
    case page(JSONObject)
    /// 410 `SYNC_CURSOR_INVALID`.
    case cursorInvalid(JSONObject)
    /// Any other failure; status 0 — no answer (network).
    case failed(status: Int, retryAfterMs: Int64?)
}

/// Unread counts of every conversation, with `last_message_id` where the list has the field (G7).
public struct UnreadSnapshot: Sendable, Equatable {
    public var counts: [String: Int64]
    public var lastMessageIds: [String: Int64?]

    public init(counts: [String: Int64], lastMessageIds: [String: Int64?]) {
        self.counts = counts
        self.lastMessageIds = lastMessageIds
    }
}

/// The answer to a `POST /api/messages/...`; status 0 — no answer (network).
public struct HTTPOutcome: Sendable, Equatable {
    public var status: Int
    public var body: JSONValue?

    public init(status: Int, body: JSONValue?) {
        self.status = status
        self.body = body
    }
}

/// HTTP the engine needs (`openapi.yaml` `/sync`, `/messages/...`, `/channels`, `/conversations/direct`).
public protocol DeliveryBackend: Sendable {
    func sync(cursor: String?, limit: Int64) async -> SyncOutcome
    /// The latest page of a conversation (`direct:3`, `channel:5`), oldest first. Throws when unavailable.
    func history(_ conversation: String) async throws -> [JSONObject]
    /// Throws when either list is unavailable.
    func unreadSnapshot() async throws -> UnreadSnapshot
    func post(path: String, body: JSONObject) async -> HTTPOutcome
}

/// What the store holds (`delivery-state.md` §6.3 `app_restart`: `me`, the cursor, `seq`, the
/// outbox, `ops`, the cancelled keys) and the platform's conversation cache.
public struct StoredDelivery: Sendable, Equatable {
    public var me: Int64?
    public var cursor: String?
    public var seq: Int64 = 0
    public var outbox: [OutboxEntry] = []
    public var ops: [DeliveryOp] = []
    public var cancelled: [String] = []
    /// Conversation → server records (with this device's status), oldest first.
    public var cache: [String: [JSONObject]] = [:]

    public init(me: Int64? = nil, cursor: String? = nil, seq: Int64 = 0, outbox: [OutboxEntry] = [], ops: [DeliveryOp] = [], cancelled: [String] = [], cache: [String: [JSONObject]] = [:]) {
        self.me = me
        self.cursor = cursor
        self.seq = seq
        self.outbox = outbox
        self.ops = ops
        self.cancelled = cancelled
        self.cache = cache
    }
}

/// Durable storage of the delivery model (`delivery-state.md` §5 `persist`).
public protocol DeliveryStore: Sendable {
    func load() async throws -> StoredDelivery
    /// Writes `slices` of `state` (and `me`) in one transaction, with the `cache` changes in the same
    /// transaction. Returns only once the data is on disk; throws when it could not be written.
    func persist(slices: [String], state: DeliveryState, cache: [String: [JSONObject]]) async throws
    /// Conversation cache only (no contract slice changed), with the account it belongs to; an empty
    /// list drops the conversation.
    func writeCache(_ cache: [String: [JSONObject]], me: Int64?) async throws
    /// Everything — the account's data is discarded.
    func clear() async throws
}

/// Messages of one conversation kept for the next start.
public enum DeliveryCache {
    public static let perConversation = 200
}

/// One server message record (`openapi.yaml` `Message`) with its id, as pages return it.
public struct MessageRecord: Sendable, Equatable, Identifiable {
    public let id: Int64
    public let json: JSONObject

    public init?(_ json: JSONObject) {
        guard let id = json["id"]?.int64 else { return nil }
        self.id = id
        self.json = json
    }
}

/// Sleeps for the engine's alarms and backoffs; tests advance a manual clock instead.
public protocol DeliveryClock: Sendable {
    /// Epoch milliseconds.
    func now() -> Int64
    /// Returns after `milliseconds` (at once for zero or less); throws when cancelled.
    func sleep(milliseconds: Int64) async throws
}

/// The wall clock.
public struct SystemDeliveryClock: DeliveryClock {
    public init() {}

    public func now() -> Int64 {
        Int64((Date().timeIntervalSince1970 * 1_000).rounded())
    }

    public func sleep(milliseconds: Int64) async throws {
        guard milliseconds > 0 else { return }
        try await Task.sleep(nanoseconds: UInt64(milliseconds) * 1_000_000)
    }
}
