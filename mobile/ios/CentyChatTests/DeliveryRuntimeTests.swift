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
        XCTAssertEqual(UnsentNotice.text(1), "1 неотправленное сообщение будет удалено")
        XCTAssertEqual(UnsentNotice.text(3), "3 неотправленных сообщения будут удалены")
        XCTAssertEqual(UnsentNotice.text(5), "5 неотправленных сообщений будут удалены")
        XCTAssertEqual(UnsentNotice.text(11), "11 неотправленных сообщений будут удалены")
        XCTAssertEqual(UnsentNotice.text(21), "21 неотправленное сообщение будет удалено")
        XCTAssertEqual(UnsentNotice.text(112), "112 неотправленных сообщений будут удалены")
    }
}
