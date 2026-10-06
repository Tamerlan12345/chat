import Foundation
import XCTest
@testable import CentyChat

/// The delivery model on disk: what a persist writes comes back after the app is gone.
final class SwiftDataDeliveryStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("delivery-store-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func state() -> DeliveryState {
        var state = DeliveryState(me: 2)
        state.sync.cursor = "5e7a1c0d9b3f4a62.11"
        state.seq = 3
        var sending = OutboxEntry(clientMsgId: "a0000001-0000-4000-8000-000000000001", conversation: "direct:3", seq: 2, text: "Первое", replyToId: 9)
        sending.state = OutboxEntry.sending
        sending.attempts = 1
        sending.maybeStored = true
        let file = OutboxEntry(clientMsgId: "a0000001-0000-4000-8000-000000000002", conversation: "channel:5", seq: 3, text: "Акт.pdf", msgType: "file", metadata: ["file_id": 42])
        state.outbox = [sending, file]
        state.ops = [DeliveryOp(op: DeliveryOp.delete, messageId: 77, text: nil), DeliveryOp(op: DeliveryOp.edit, messageId: 78, text: "Правка")]
        state.cancelled = ["k-1", "k-2"]
        return state
    }

    func testAPersistedModelComesBackAfterTheProcessIsGone() async throws {
        let written = state()
        let cache: [String: [JSONObject]] = ["direct:3": [DeliveryFixtures.record(id: 10, from: 3, to: 2, text: "Кэш")]]
        try await SwiftDataDeliveryStore(directory: directory).persist(slices: ["cancelled", "cursor", "ops", "outbox"], state: written, cache: cache)

        let loaded = try await SwiftDataDeliveryStore(directory: directory).load()

        XCTAssertEqual(loaded.me, 2)
        XCTAssertEqual(loaded.cursor, written.sync.cursor)
        XCTAssertEqual(loaded.seq, 3)
        XCTAssertEqual(loaded.outbox, written.outbox, "every field of an entry survives, in seq order")
        XCTAssertEqual(loaded.ops, written.ops, "operations keep their order")
        XCTAssertEqual(loaded.cancelled, ["k-1", "k-2"])
        XCTAssertEqual(loaded.cache["direct:3"]?.first?["text"], "Кэш")
    }

    func testOnlyTheNamedSlicesAreWritten() async throws {
        let store = SwiftDataDeliveryStore(directory: directory)
        try await store.persist(slices: ["outbox"], state: state(), cache: [:])
        var next = state()
        next.outbox = []
        next.sync.cursor = "другой"

        try await store.persist(slices: ["cursor"], state: next, cache: [:])
        let loaded = try await store.load()

        XCTAssertEqual(loaded.cursor, "другой")
        XCTAssertEqual(loaded.outbox.count, 2, "the outbox slice was not part of this write")
    }

    func testAWipeLeavesNothingOfTheAccount() async throws {
        let store = SwiftDataDeliveryStore(directory: directory)
        try await store.persist(slices: ["cancelled", "cursor", "ops", "outbox"], state: state(), cache: ["direct:3": [DeliveryFixtures.record(id: 1, from: 3, to: 2)]])
        try await store.putUpload(PendingUpload(clientMsgId: "k", conversation: "direct:3", owner: 2, createdAt: 1, name: "a.pdf", size: 1, mimeType: nil, localPath: "k/a.pdf", replyToId: nil))

        try await store.clear()
        let loaded = try await store.load()
        let uploads = try await store.uploads()

        XCTAssertEqual(loaded, StoredDelivery())
        XCTAssertTrue(uploads.isEmpty)
    }

    func testTheCacheNamesItsAccountAndAnEmptyListDropsAConversation() async throws {
        let store = SwiftDataDeliveryStore(directory: directory)
        try await store.writeCache(["direct:3": [DeliveryFixtures.record(id: 1, from: 3, to: 2)], "channel:5": [DeliveryFixtures.record(id: 2, from: 4, to: 5, type: "channel")]], me: 2)
        try await store.writeCache(["channel:5": []], me: 2)

        let loaded = try await store.load()

        XCTAssertEqual(loaded.me, 2)
        XCTAssertEqual(Array(loaded.cache.keys), ["direct:3"])
    }

    func testWaitingFilesAreKeptByKey() async throws {
        let store = SwiftDataDeliveryStore(directory: directory)
        var upload = PendingUpload(clientMsgId: "k", conversation: "direct:3", owner: 2, createdAt: 1, name: "a.pdf", size: 1, mimeType: nil, localPath: "k/a.pdf", replyToId: 4)
        try await store.putUpload(upload)
        upload.failed = true
        upload.error = "Файлы .pdf к отправке не разрешены"
        try await store.putUpload(upload)

        let uploads = try await SwiftDataDeliveryStore(directory: directory).uploads()
        XCTAssertEqual(uploads, [upload])

        try await store.removeUpload("k")
        let left = try await store.uploads()
        XCTAssertTrue(left.isEmpty)
    }

    func testTheStoreIsKeptOutOfBackups() async throws {
        try await SwiftDataDeliveryStore(directory: directory).persist(slices: ["outbox"], state: state(), cache: [:])

        let values = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
    }
}
