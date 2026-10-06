import Foundation

/// A file picked for sending that is not in the outbox yet: it goes up first, then enters the outbox
/// as a `file`/`image` message with the same `client_msg_id` (`delivery-state.md` §3.1 `metadata`).
public struct PendingUpload: Codable, Sendable, Equatable, Identifiable {
    public var id: String { clientMsgId }

    public var clientMsgId: String
    public var conversation: String
    /// The account that picked the file; it goes up only under that account.
    public var owner: Int64
    /// Epoch milliseconds.
    public var createdAt: Int64
    /// The name shown and sent (`text` of the message, as on desktop).
    public var name: String
    public var size: Int64?
    public var mimeType: String?
    public var width: Int?
    public var height: Int?
    /// The app's private copy, relative to the outbox files folder (survives termination, unlike a
    /// picker's grant).
    public var localPath: String
    public var replyToId: Int64?
    /// The server refused it (`error` is its reason in Russian); it waits for «Повторить» / «Удалить».
    public var failed: Bool = false
    public var error: String?

    public init(
        clientMsgId: String,
        conversation: String,
        owner: Int64,
        createdAt: Int64,
        name: String,
        size: Int64?,
        mimeType: String?,
        width: Int? = nil,
        height: Int? = nil,
        localPath: String,
        replyToId: Int64?,
        failed: Bool = false,
        error: String? = nil
    ) {
        self.clientMsgId = clientMsgId
        self.conversation = conversation
        self.owner = owner
        self.createdAt = createdAt
        self.name = name
        self.size = size
        self.mimeType = mimeType
        self.width = width
        self.height = height
        self.localPath = localPath
        self.replyToId = replyToId
        self.failed = failed
        self.error = error
    }
}

/// Where the files waiting to go up are remembered.
public protocol PendingUploadStore: Sendable {
    func uploads() async throws -> [PendingUpload]
    func putUpload(_ upload: PendingUpload) async throws
    func removeUpload(_ clientMsgId: String) async throws
    func clearUploads() async throws
}

/// In memory: tests and the idle unit-test host.
public actor InMemoryPendingUploadStore: PendingUploadStore {
    private var rows: [String: PendingUpload] = [:]
    private var failingPuts = 0
    private var failingClears = 0

    public init() {}

    public func failNextPuts(_ count: Int) {
        failingPuts = count
    }

    public func failNextClears(_ count: Int) {
        failingClears = count
    }

    public func uploads() async throws -> [PendingUpload] {
        rows.values.sorted { $0.createdAt < $1.createdAt }
    }

    public func putUpload(_ upload: PendingUpload) async throws {
        if failingPuts > 0 {
            failingPuts -= 1
            throw InMemoryDeliveryStore.Failure(operation: .persist)
        }
        rows[upload.clientMsgId] = upload
    }

    public func removeUpload(_ clientMsgId: String) async throws {
        rows[clientMsgId] = nil
    }

    public func clearUploads() async throws {
        if failingClears > 0 {
            failingClears -= 1
            throw InMemoryDeliveryStore.Failure(operation: .clear)
        }
        rows.removeAll()
    }
}
