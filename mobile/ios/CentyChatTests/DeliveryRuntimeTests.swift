import Foundation
import XCTest
@testable import CentyChat

/// The queue's owner, the flush without a socket, and what sign-out does with unsent messages.
@MainActor
final class DeliveryRuntimeTests: XCTestCase {
    private var store: InMemoryDeliveryStore!
    private var link: FakeDeliveryLink!
    private var backend: FakeDeliveryBackend!
    private var clock: ManualDeliveryClock!
    private var engine: DeliveryEngine!
    private var uploads: AttachmentUploads!
    private var user: Int64? = 2
    private var reconnects = 0
    private var folder: URL!

    override func setUp() async throws {
        store = InMemoryDeliveryStore()
        link = FakeDeliveryLink()
        backend = FakeDeliveryBackend()
        clock = ManualDeliveryClock()
        user = 2
        reconnects = 0
        folder = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true).appendingPathComponent("runtime-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func makeRuntime(store: InMemoryDeliveryStore? = nil) async -> DeliveryRuntime {
        engine = DeliveryEngine(store: store ?? self.store, link: link, backend: backend, clock: clock)
        engine.start()
        uploads = AttachmentUploads(
            store: InMemoryPendingUploadStore(),
            files: AttachmentFiles(root: folder),
            uploader: FakeUploader(),
            engine: engine,
            clock: clock,
            owner: { [unowned self] in self.user }
        )
        uploads.start()
        let runtime = DeliveryRuntime(
            engine: engine,
            uploads: uploads,
            currentUser: { [unowned self] in self.user },
            reconnect: { [unowned self] in self.reconnects += 1 },
            clock: clock,
            readyTimeoutMs: 5_000
        )
        await settle()
        return runtime
    }

    private func settle() async {
        for _ in 0..<15 {
            await engine?.idle()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    private func answerPostsWithEchoes() {
        backend.answerPosts { body in
            HTTPOutcome(status: 201, body: .object(DeliveryFixtures.record(
                id: 900, from: 2, to: 3, text: body["text"]?.string ?? "", clientMsgId: body["client_msg_id"]?.string
            )))
        }
    }

    func testUnsentCountsTheAccountsQueuedMessagesButNotCancelledOnes() async {
        let runtime = await makeRuntime()
        _ = await engine.enqueue(conversation: "direct:3", text: "раз", owner: 2)
        _ = await engine.enqueue(conversation: "direct:3", text: "два", owner: 2)

        XCTAssertEqual(runtime.unsentCount, 2)
        user = 4
        XCTAssertEqual(runtime.unsentCount, 0, "another account's queue is never counted (nor shown)")
    }

    func testExplicitSignOutDeletesTheUnsentMessages() async throws {
        let runtime = await makeRuntime()
        _ = await engine.enqueue(conversation: "direct:3", text: "раз", owner: 2)

        try await runtime.discardForSignOut()

        XCTAssertEqual(runtime.unsentCount, 0)
        let stored = await store.contents
        XCTAssertTrue(stored.outbox.isEmpty)
    }

    func testASignOutWhoseWipeFailsSaysSo() async {
        let runtime = await makeRuntime()
        _ = await engine.enqueue(conversation: "direct:3", text: "раз", owner: 2)
        await store.fail(.clear, times: 1)

        do {
            try await runtime.discardForSignOut()
            XCTFail("the sign-out must not go on as if the messages were deleted")
        } catch {}
    }

    func testTheFlushSendsTheQueueOverHTTPWithoutASocket() async {
        let runtime = await makeRuntime()
        answerPostsWithEchoes()
        _ = await engine.enqueue(conversation: "direct:3", text: "по HTTP", owner: 2)

        let result = await runtime.flushInBackground()

        XCTAssertEqual(result, .done)
        XCTAssertEqual(backend.postedBodies.map { $0["text"]?.string }, ["по HTTP"])
        XCTAssertTrue(engine.state.outbox.isEmpty)
    }

    func testTheFlushLeavesAnOpenSocketToItsPump() async {
        let runtime = await makeRuntime()
        engine.receive(DeliveryFixtures.authSuccess(2))
        await settle()
        _ = await engine.enqueue(conversation: "direct:3", text: "через сокет", owner: 2)

        _ = await runtime.flushInBackground()

        XCTAssertTrue(backend.postedBodies.isEmpty)
    }

    func testTheFlushNeverSendsAnotherAccountsQueue() async {
        let queued = OutboxEntry(clientMsgId: "a0000001-0000-4000-8000-000000000009", conversation: "direct:3", seq: 1, text: "Алисино")
        let runtime = await makeRuntime(store: InMemoryDeliveryStore(StoredDelivery(me: 2, seq: 1, outbox: [queued])))
        answerPostsWithEchoes()
        user = 4

        _ = await runtime.flushInBackground()

        XCTAssertTrue(backend.postedBodies.isEmpty)
        XCTAssertTrue(engine.state.outbox.isEmpty, "the other account's queue is wiped, not sent")
    }

    func testTheFlushWaitsForAnUnreadableStoreOnlySoLong() async {
        let broken = InMemoryDeliveryStore()
        await broken.fail(.load)
        let runtime = await makeRuntime(store: broken)

        async let result = runtime.flushInBackground()
        // Five seconds on the engine's clock, in the runtime's 200 ms steps.
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 2_000_000)
            clock.advance(by: 200)
        }

        let answer = await result
        XCTAssertEqual(answer, .retryLater)
    }

    func testTheNetworkComingBackReconnectsAndFlushes() async {
        let runtime = await makeRuntime()
        answerPostsWithEchoes()
        _ = await engine.enqueue(conversation: "direct:3", text: "сеть вернулась", owner: 2)

        await runtime.networkBecameAvailable()
        await settle()

        XCTAssertEqual(reconnects, 1)
        XCTAssertEqual(backend.postedBodies.count, 1)
    }
}

/// The line the sign-out and account-deletion confirmations add when messages wait.
final class UnsentNoticeTests: XCTestCase {
    func testTheCountIsSaidInProperRussian() {
        XCTAssertNil(UnsentNotice.text(0))
        XCTAssertEqual(UnsentNotice.text(1), "1 неотправленное сообщение будет удалено.")
        XCTAssertEqual(UnsentNotice.text(3), "3 неотправленных сообщения будут удалены.")
        XCTAssertEqual(UnsentNotice.text(5), "5 неотправленных сообщений будут удалены.")
        XCTAssertEqual(UnsentNotice.text(11), "11 неотправленных сообщений будут удалены.")
        XCTAssertEqual(UnsentNotice.text(21), "21 неотправленное сообщение будет удалено.")
        XCTAssertEqual(UnsentNotice.text(112), "112 неотправленных сообщений будут удалены.")
    }
}

/// Signing out while the store cannot be read: the number of unsent messages is unknown.
@MainActor
final class UnsentUnknownTests: XCTestCase {
    func testTheCountIsUnknownWhileTheStoreCannotBeRead() async {
        let broken = InMemoryDeliveryStore()
        await broken.fail(.load)
        let clock = ManualDeliveryClock()
        let engine = DeliveryEngine(store: broken, link: FakeDeliveryLink(), backend: FakeDeliveryBackend(), clock: clock)
        engine.start()
        let folder = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("u-\(UUID().uuidString)")
        let uploads = AttachmentUploads(store: InMemoryPendingUploadStore(), files: AttachmentFiles(root: folder), uploader: FakeUploader(), engine: engine, clock: clock, owner: { 2 })
        let runtime = DeliveryRuntime(engine: engine, uploads: uploads, currentUser: { 2 }, reconnect: {}, clock: clock)
        for _ in 0..<10 {
            await engine.idle()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }

        XCTAssertNil(runtime.unsentCount)
        XCTAssertEqual(UnsentNotice.text(nil), "Не удалось проверить неотправленные сообщения. Если они есть, они будут удалены.")
    }
}

/// An explicit sign-out deletes the unsent messages and files together, or nothing.
@MainActor
final class SignOutDiscardTests: XCTestCase {
    private var store: InMemoryDeliveryStore!
    private var rows: InMemoryPendingUploadStore!
    private var engine: DeliveryEngine!
    private var uploads: AttachmentUploads!
    private var runtime: DeliveryRuntime!
    private var link: FakeDeliveryLink!

    override func setUp() async throws {
        store = InMemoryDeliveryStore()
        rows = InMemoryPendingUploadStore()
        link = FakeDeliveryLink()
        let clock = ManualDeliveryClock()
        engine = DeliveryEngine(store: store, link: link, backend: FakeDeliveryBackend(), clock: clock)
        engine.start()
        let folder = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("discard-\(UUID().uuidString)")
        uploads = AttachmentUploads(store: rows, files: AttachmentFiles(root: folder), uploader: FakeUploader(), engine: engine, clock: clock, owner: { 2 })
        uploads.start()
        runtime = DeliveryRuntime(engine: engine, uploads: uploads, currentUser: { 2 }, reconnect: {}, clock: clock)
        try await engine.adopt(2)
    }

    private func settle() async {
        for _ in 0..<10 {
            await engine.idle()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    func testWhenTheWaitingFilesCannotBeDeletedNothingIsDeletedAndTheQueueKeepsWorking() async throws {
        _ = await engine.enqueue(conversation: "direct:3", text: "Останусь", owner: 2)
        await rows.failNextClears(1)

        do {
            try await runtime.discardForSignOut()
            XCTFail("the sign-out must hear that the files could not be deleted")
        } catch {}
        await settle()

        XCTAssertEqual(engine.state.outbox.map(\.text), ["Останусь"], "the messages were not deleted either")
        let stored = await store.contents
        XCTAssertEqual(stored.outbox.map(\.text), ["Останусь"])
        let outcome = await engine.enqueue(conversation: "direct:3", text: "Ещё одно", owner: 2)
        XCTAssertTrue(outcome.persisted, "the account still owns its queue: new messages are taken")
        engine.receive(DeliveryFixtures.authSuccess(2))
        await settle()
        XCTAssertEqual(engine.state.connection, DeliveryState.online, "frames are taken: the engine is not deaf")
    }

    func testWhenTheMessagesCannotBeDeletedTheWaitingFilesStay() async throws {
        let picked = PickedAttachment(source: .data(Data([1])), name: "Акт.pdf", mimeType: "application/pdf")
        _ = await uploads.add(conversation: "direct:3", picked: picked, replyToId: nil, owner: 2)
        await store.fail(.clear, times: 1)

        do {
            try await runtime.discardForSignOut()
            XCTFail("the sign-out must hear that the messages could not be deleted")
        } catch {}

        XCTAssertEqual(uploads.items.map(\.pending.name), ["Акт.pdf"])
        let left = try await rows.uploads()
        XCTAssertEqual(left.map(\.name), ["Акт.pdf"], "the file's row is still on disk")
    }
}

/// A deleted account (or another server's credentials): its data goes even when one part cannot be
/// deleted at once; what failed is retried.
@MainActor
final class DiscardedAccountTests: XCTestCase {
    private var store: InMemoryDeliveryStore!
    private var rows: InMemoryPendingUploadStore!
    private var engine: DeliveryEngine!
    private var uploads: AttachmentUploads!
    private var runtime: DeliveryRuntime!
    private var clock: ManualDeliveryClock!
    private var folder: URL!

    override func setUp() async throws {
        store = InMemoryDeliveryStore()
        rows = InMemoryPendingUploadStore()
        clock = ManualDeliveryClock()
        engine = DeliveryEngine(store: store, link: FakeDeliveryLink(), backend: FakeDeliveryBackend(), clock: clock)
        engine.start()
        folder = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("discarded-\(UUID().uuidString)")
        uploads = AttachmentUploads(store: rows, files: AttachmentFiles(root: folder), uploader: FakeUploader(), engine: engine, clock: clock, owner: { 2 })
        uploads.start()
        runtime = DeliveryRuntime(engine: engine, uploads: uploads, currentUser: { 2 }, reconnect: {}, clock: clock)
        try await engine.adopt(2)
        _ = await engine.enqueue(conversation: "direct:3", text: "Удалённый аккаунт", owner: 2)
        _ = await uploads.add(conversation: "direct:3", picked: PickedAttachment(source: .data(Data([1])), name: "Акт.pdf", mimeType: "application/pdf"), replyToId: nil, owner: 2)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func settle() async {
        for _ in 0..<10 {
            await engine.idle()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    func testFilesThatCannotBeDeletedDoNotKeepTheMessagesAndAreRetried() async throws {
        await rows.failNextClears(1)

        await runtime.discardAccount()
        await settle()

        XCTAssertTrue(engine.state.outbox.isEmpty, "the messages go even though the files' rows could not")
        let stored = await store.contents
        XCTAssertTrue(stored.outbox.isEmpty)
        XCTAssertTrue(uploads.items.isEmpty)
        let copies = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        XCTAssertTrue(copies.isEmpty, "the copies are deleted")

        clock.advance(by: 1_000)
        await settle()
        let left = try await rows.uploads()
        XCTAssertTrue(left.isEmpty, "the rows are deleted on the retry")
    }

    func testMessagesThatCannotBeDeletedAreRetriedAndTheFilesGoAnyway() async throws {
        await store.fail(.clear, times: 1)

        await runtime.discardAccount()
        await settle()

        XCTAssertTrue(engine.state.outbox.isEmpty, "emptied in memory at once")
        let rowsLeft = try await rows.uploads()
        XCTAssertTrue(rowsLeft.isEmpty, "the files' rows are not written back for a discarded account")

        clock.advance(by: 1_000)
        await settle()
        let stored = await store.contents
        XCTAssertTrue(stored.outbox.isEmpty, "the store is wiped on the retry")
    }
}
