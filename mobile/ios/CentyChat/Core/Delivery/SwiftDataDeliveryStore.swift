import Foundation
import SwiftData

/// The delivery model on disk (SwiftData, `Application Support/Delivery`, excluded from backup and
/// device transfer): `me`, the cursor, `seq`, the outbox, `ops`, the cancelled keys, the
/// conversation cache and the files waiting to go up.
///
/// The container opens lazily: a store that cannot be opened makes `load` throw, so the engine fails
/// closed and retries — nothing is ever deleted to "repair" it (no destructive migration).
public actor SwiftDataDeliveryStore: DeliveryStore, PendingUploadStore {
    private let directory: URL
    private var worker: DeliveryModelWorker?

    public init(directory: URL) {
        self.directory = directory
    }

    /// `Application Support/Delivery`.
    public static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return base.appendingPathComponent("Delivery", isDirectory: true)
    }

    /// Deletes the store files (UI tests start from a fresh install).
    public static func removeFiles(at directory: URL) throws {
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
    }

    private func open() throws -> DeliveryModelWorker {
        if let worker { return worker }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var folder = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
        let schema = Schema(versionedSchema: DeliverySchemaV1.self)
        let configuration = ModelConfiguration(schema: schema, url: directory.appendingPathComponent("delivery.store"))
        let container = try ModelContainer(for: schema, migrationPlan: DeliveryMigrationPlan.self, configurations: [configuration])
        let opened = DeliveryModelWorker(modelContainer: container)
        worker = opened
        return opened
    }

    public func load() async throws -> StoredDelivery {
        try await open().load()
    }

    public func persist(slices: [String], state: DeliveryState, cache: [String: [JSONObject]]) async throws {
        try await open().persist(slices: slices, state: state, cache: cache)
    }

    public func writeCache(_ cache: [String: [JSONObject]], me: Int64?) async throws {
        try await open().writeCache(cache, me: me)
    }

    public func clear() async throws {
        try await open().clear()
    }

    public func uploads() async throws -> [PendingUpload] {
        try await open().uploads()
    }

    public func putUpload(_ upload: PendingUpload) async throws {
        try await open().putUpload(upload)
    }

    public func removeUpload(_ clientMsgId: String) async throws {
        try await open().removeUpload(clientMsgId)
    }

    public func clearUploads() async throws {
        try await open().clearUploads()
    }
}

/// The schema of the delivery store. A later change adds `DeliverySchemaV2` and a migration stage —
/// the outbox is never dropped to make a migration pass.
enum DeliverySchemaV1: VersionedSchema {
    static var versionIdentifier: Schema.Version { Schema.Version(1, 0, 0) }

    static var models: [any PersistentModel.Type] {
        [Meta.self, Outbox.self, Op.self, CachedConversation.self, Upload.self]
    }

    /// One row: the account and the scalar slices.
    @Model
    final class Meta {
        @Attribute(.unique) var key: String
        var me: Int64?
        var cursor: String?
        var seq: Int64
        /// JSON array of the cancelled keys, oldest first.
        var cancelled: Data

        init(key: String = "meta", me: Int64?, cursor: String?, seq: Int64, cancelled: Data) {
            self.key = key
            self.me = me
            self.cursor = cursor
            self.seq = seq
            self.cancelled = cancelled
        }
    }

    /// An outbox entry (`delivery-state.md` §3.1) as its contract JSON.
    @Model
    final class Outbox {
        @Attribute(.unique) var clientMsgId: String
        var seq: Int64
        var payload: Data

        init(clientMsgId: String, seq: Int64, payload: Data) {
            self.clientMsgId = clientMsgId
            self.seq = seq
            self.payload = payload
        }
    }

    /// An operation (§3.2) as its contract JSON, in queue order.
    @Model
    final class Op {
        var position: Int
        var payload: Data

        init(position: Int, payload: Data) {
            self.position = position
            self.payload = payload
        }
    }

    /// The last messages of one conversation (server records, oldest first).
    @Model
    final class CachedConversation {
        @Attribute(.unique) var conversation: String
        var payload: Data

        init(conversation: String, payload: Data) {
            self.conversation = conversation
            self.payload = payload
        }
    }

    /// A file picked for sending that is not in the outbox yet.
    @Model
    final class Upload {
        @Attribute(.unique) var clientMsgId: String
        var payload: Data

        init(clientMsgId: String, payload: Data) {
            self.clientMsgId = clientMsgId
            self.payload = payload
        }
    }
}

enum DeliveryMigrationPlan: SchemaMigrationPlan {
    static var schemas: [any VersionedSchema.Type] { [DeliverySchemaV1.self] }
    static var stages: [MigrationStage] { [] }
}

/// Works on the store's context, on its own serial executor.
@ModelActor
actor DeliveryModelWorker {
    private typealias Meta = DeliverySchemaV1.Meta
    private typealias Outbox = DeliverySchemaV1.Outbox
    private typealias Op = DeliverySchemaV1.Op
    private typealias Cached = DeliverySchemaV1.CachedConversation
    private typealias Upload = DeliverySchemaV1.Upload

    func load() throws -> StoredDelivery {
        let meta = try modelContext.fetch(FetchDescriptor<Meta>()).first
        let outbox = try modelContext.fetch(FetchDescriptor<Outbox>(sortBy: [SortDescriptor(\.seq)]))
        let ops = try modelContext.fetch(FetchDescriptor<Op>(sortBy: [SortDescriptor(\.position)]))
        let cached = try modelContext.fetch(FetchDescriptor<Cached>())
        var stored = StoredDelivery()
        stored.me = meta?.me
        stored.cursor = meta?.cursor
        stored.seq = meta?.seq ?? 0
        stored.cancelled = meta.flatMap { JSONValue.parse($0.cancelled)?.array?.compactMap(\.string) } ?? []
        stored.outbox = try outbox.map { row in
            guard let json = JSONValue.parse(row.payload) else { throw StoreError.unreadable("outbox \(row.clientMsgId)") }
            return OutboxEntry(json: json)
        }
        stored.ops = try ops.map { row in
            guard let json = JSONValue.parse(row.payload) else { throw StoreError.unreadable("op \(row.position)") }
            return DeliveryOp(json: json)
        }
        for row in cached {
            stored.cache[row.conversation] = JSONValue.parse(row.payload)?.array?.compactMap(\.object) ?? []
        }
        return stored
    }

    func persist(slices: [String], state: DeliveryState, cache: [String: [JSONObject]]) throws {
        do {
            let meta = try metaRow()
            meta.me = state.me
            if slices.contains("cursor") { meta.cursor = state.sync.cursor }
            if slices.contains("cancelled") { meta.cancelled = JSONValue.array(state.cancelled.map(JSONValue.string)).jsonData }
            if slices.contains("outbox") {
                meta.seq = state.seq
                let rows = try modelContext.fetch(FetchDescriptor<Outbox>())
                var byKey: [String: Outbox] = [:]
                for row in rows { byKey[row.clientMsgId] = row }
                let keep = Set(state.outbox.map(\.clientMsgId))
                for row in rows where !keep.contains(row.clientMsgId) { modelContext.delete(row) }
                for entry in state.outbox {
                    let payload = entry.json.jsonData
                    if let row = byKey[entry.clientMsgId] {
                        row.seq = entry.seq
                        row.payload = payload
                    } else {
                        modelContext.insert(Outbox(clientMsgId: entry.clientMsgId, seq: entry.seq, payload: payload))
                    }
                }
            }
            if slices.contains("ops") {
                try modelContext.delete(model: Op.self)
                for (position, op) in state.ops.enumerated() {
                    modelContext.insert(Op(position: position, payload: op.json.jsonData))
                }
            }
            try apply(cache)
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    func writeCache(_ cache: [String: [JSONObject]], me: Int64?) throws {
        do {
            let meta = try metaRow()
            meta.me = me
            try apply(cache)
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    func clear() throws {
        do {
            try modelContext.delete(model: Meta.self)
            try modelContext.delete(model: Outbox.self)
            try modelContext.delete(model: Op.self)
            try modelContext.delete(model: Cached.self)
            try modelContext.delete(model: Upload.self)
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    func uploads() throws -> [PendingUpload] {
        try modelContext.fetch(FetchDescriptor<Upload>()).compactMap { row in
            try? JSONDecoder().decode(PendingUpload.self, from: row.payload)
        }.sorted { $0.createdAt < $1.createdAt }
    }

    func putUpload(_ upload: PendingUpload) throws {
        do {
            let payload = try JSONEncoder().encode(upload)
            let key = upload.clientMsgId
            if let row = try modelContext.fetch(FetchDescriptor<Upload>(predicate: #Predicate { $0.clientMsgId == key })).first {
                row.payload = payload
            } else {
                modelContext.insert(Upload(clientMsgId: key, payload: payload))
            }
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    func removeUpload(_ clientMsgId: String) throws {
        do {
            try modelContext.delete(model: Upload.self, where: #Predicate { $0.clientMsgId == clientMsgId })
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    func clearUploads() throws {
        do {
            try modelContext.delete(model: Upload.self)
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    private func metaRow() throws -> Meta {
        if let row = try modelContext.fetch(FetchDescriptor<Meta>()).first { return row }
        let row = Meta(me: nil, cursor: nil, seq: 0, cancelled: Data("[]".utf8))
        modelContext.insert(row)
        return row
    }

    private func apply(_ cache: [String: [JSONObject]]) throws {
        guard !cache.isEmpty else { return }
        let rows = try modelContext.fetch(FetchDescriptor<Cached>())
        var byConversation: [String: Cached] = [:]
        for row in rows { byConversation[row.conversation] = row }
        for (conversation, records) in cache {
            if records.isEmpty {
                if let row = byConversation[conversation] { modelContext.delete(row) }
                continue
            }
            let payload = JSONValue.array(records.map(JSONValue.object)).jsonData
            if let row = byConversation[conversation] {
                row.payload = payload
            } else {
                modelContext.insert(Cached(conversation: conversation, payload: payload))
            }
        }
    }

    enum StoreError: Error {
        case unreadable(String)
    }
}
