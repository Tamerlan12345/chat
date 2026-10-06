import Foundation
import XCTest
@testable import CentyChat

/// Files on their way into the outbox: kept as a private copy and a stored row before anything else,
/// uploaded when connected, then enqueued with the same `client_msg_id`.
@MainActor
final class AttachmentUploadsTests: XCTestCase {
    private var folder: URL!
    private var store: InMemoryPendingUploadStore!
    private var engine: DeliveryEngine!
    private var uploader: FakeUploader!
    private var clock: ManualDeliveryClock!
    private var signedIn: Int64? = 2

    override func setUp() async throws {
        folder = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("uploads-\(UUID().uuidString)", isDirectory: true)
        store = InMemoryPendingUploadStore()
        uploader = FakeUploader()
        clock = ManualDeliveryClock()
        engine = DeliveryEngine(store: InMemoryDeliveryStore(), link: FakeDeliveryLink(), backend: FakeDeliveryBackend(), clock: clock)
        engine.start()
        await engine.idle()
        // The queue belongs to account 2, adopted as at sign-in.
        try await engine.adopt(2)
        signedIn = 2
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func makeUploads() -> AttachmentUploads {
        let uploads = AttachmentUploads(
            store: store,
            files: AttachmentFiles(root: folder),
            uploader: uploader,
            engine: engine,
            clock: clock,
            owner: { [unowned self] in self.signedIn }
        )
        uploads.start()
        return uploads
    }

    private func picked(_ name: String = "Акт.pdf", bytes: Int = 64) throws -> PickedAttachment {
        let source = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("src-\(UUID().uuidString)-\(name)")
        try Data(repeating: 7, count: bytes).write(to: source)
        return PickedAttachment(source: .file(source), name: name, mimeType: "application/pdf")
    }

    private func settle() async {
        for _ in 0..<15 {
            await engine.idle()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    func testAPickedFileIsKeptAndRecordedBeforeAnythingElse() async throws {
        let uploads = makeUploads()

        let accepted = await uploads.add(conversation: "direct:3", picked: try picked(), replyToId: nil, owner: 2)

        XCTAssertTrue(accepted)
        let rows = try await store.uploads()
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.owner, 2, "every waiting file names its account")
        let copy = AttachmentFiles(root: folder).url(rows[0].localPath)
        XCTAssertEqual(try Data(contentsOf: copy).count, 64, "a private copy survives the picker's grant")
        XCTAssertEqual(uploader.calls, 0, "offline: it waits")
    }

    func testOnlineTheFileGoesUpThenEntersTheOutboxWithTheSameKey() async throws {
        let uploads = makeUploads()
        uploader.answer = .success(FileUploadResponse(id: 42, originalName: "Акт.pdf", storedFilename: "x", fileSize: 64, mimeType: "application/pdf", url: "/api/files/download/42"))
        _ = await uploads.add(conversation: "direct:3", picked: try picked(), replyToId: 77, owner: 2)
        let key = try XCTUnwrap(uploads.items.first?.pending.clientMsgId)

        uploads.setOnline(true)
        await settle()

        let entry = try XCTUnwrap(engine.state.outbox.first)
        XCTAssertEqual(entry.clientMsgId, key)
        XCTAssertEqual(entry.msgType, "file")
        XCTAssertEqual(entry.text, "Акт.pdf", "the file name is the text, as on desktop")
        XCTAssertEqual(entry.replyToId, 77)
        XCTAssertEqual(entry.metadata?["file_id"], 42)
        XCTAssertEqual(entry.metadata?["url"], "/api/files/download/42")
        XCTAssertTrue(uploads.items.isEmpty)
        let rows = try await store.uploads()
        XCTAssertTrue(rows.isEmpty)
        XCTAssertNotNil(uploads.handedOver[key], "the local copy is drawn until the server confirms")
    }

    func testANetworkFailureLeavesTheFileQueuedAndItGoesAgain() async throws {
        let uploads = makeUploads()
        uploader.answer = .failure(URLError(.networkConnectionLost))
        _ = await uploads.add(conversation: "direct:3", picked: try picked(), replyToId: nil, owner: 2)

        uploads.setOnline(true)
        await settle()
        XCTAssertEqual(uploads.items.first?.pending.failed, false, "no answer is not a refusal")
        XCTAssertEqual(uploader.calls, 1)

        uploader.answer = .success(FileUploadResponse(id: 43, originalName: "Акт.pdf", storedFilename: "x", fileSize: 64, mimeType: "application/pdf", url: "/api/files/download/43"))
        clock.advance(by: AttachmentUploads.retryDelayMs)
        await settle()

        XCTAssertEqual(uploader.calls, 2)
        XCTAssertEqual(engine.state.outbox.count, 1)
    }

    func testARefusalFailsTheFileWithTheServersReasonUntilRetried() async throws {
        let uploads = makeUploads()
        uploader.answer = .failure(APIError.httpError(statusCode: 415, message: "Файлы .pdf к отправке не разрешены", code: "ext-not-allowed"))
        _ = await uploads.add(conversation: "direct:3", picked: try picked(), replyToId: nil, owner: 2)
        let key = try XCTUnwrap(uploads.items.first?.pending.clientMsgId)

        uploads.setOnline(true)
        await settle()

        XCTAssertEqual(uploads.items.first?.pending.failed, true)
        XCTAssertEqual(uploads.items.first?.pending.error, "Файлы .pdf к отправке не разрешены")
        XCTAssertEqual(uploads.lastNotice?.text, "Файлы .pdf к отправке не разрешены")
        let stored = try await store.uploads()
        XCTAssertEqual(stored.first?.failed, true, "the refusal survives a restart")

        uploader.answer = .success(FileUploadResponse(id: 44, originalName: "Акт.pdf", storedFilename: "x", fileSize: 64, mimeType: "application/pdf", url: "/api/files/download/44"))
        uploads.retry(key)
        await settle()
        XCTAssertEqual(engine.state.outbox.map(\.clientMsgId), [key])
    }

    func testACancelledFileIsForgottenAndNeverGoesUp() async throws {
        let uploads = makeUploads()
        _ = await uploads.add(conversation: "direct:3", picked: try picked(), replyToId: nil, owner: 2)
        let pending = try XCTUnwrap(uploads.items.first?.pending)

        await uploads.cancel(pending.clientMsgId)
        uploads.setOnline(true)
        await settle()

        XCTAssertEqual(uploader.calls, 0)
        XCTAssertTrue(uploads.items.isEmpty)
        let rows = try await store.uploads()
        XCTAssertTrue(rows.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: AttachmentFiles(root: folder).url(pending.localPath).path))
    }

    func testAFileGoesUpOnlyUnderTheAccountThatPickedIt() async throws {
        let uploads = makeUploads()
        _ = await uploads.add(conversation: "direct:3", picked: try picked(), replyToId: nil, owner: 2)
        signedIn = 4

        uploads.setOnline(true)
        await uploads.flush()
        await settle()

        XCTAssertEqual(uploader.calls, 0, "another account's file never goes up under this token")
    }

    func testWaitingFilesSurviveARestart() async throws {
        let first = makeUploads()
        _ = await first.add(conversation: "direct:3", picked: try picked("Схема.png"), replyToId: nil, owner: 2)

        let second = makeUploads()
        await second.restored()

        XCTAssertEqual(second.items.map(\.pending.name), ["Схема.png"])
    }

    func testAtMostTwoFilesGoUpAtOnceInTheOrderTheyWerePicked() async throws {
        let uploads = makeUploads()
        let gate = TestGate()
        uploader.hold(gate)
        uploader.answer = FakeUploader.done(50)
        for name in ["1.pdf", "2.pdf", "3.pdf"] {
            _ = await uploads.add(conversation: "direct:3", picked: try picked(name), replyToId: nil, owner: 2)
        }

        uploads.setOnline(true)
        await settle()
        XCTAssertEqual(uploader.calls, 2, "the server takes two uploads per person at a time (MAX_PARALLEL_UPLOADS)")
        XCTAssertEqual(uploads.items.first { $0.pending.name == "3.pdf" }?.progress, nil, "the third waits its turn")

        await gate.open()
        await settle()
        XCTAssertEqual(uploader.calls, 3)
        XCTAssertLessThanOrEqual(uploader.maxRunning, 2)
        XCTAssertEqual(engine.state.outbox.map(\.text), ["1.pdf", "2.pdf", "3.pdf"], "first picked, first queued")
    }

    func testABusyServerIsAskedAgainAfterItsRetryAfter() async throws {
        let uploads = makeUploads()
        uploader.script(
            .failure(APIError.httpError(statusCode: 429, message: "Дождитесь окончания текущих загрузок", code: nil, retryAfter: 3)),
            FakeUploader.done(60)
        )
        _ = await uploads.add(conversation: "direct:3", picked: try picked(), replyToId: nil, owner: 2)

        uploads.setOnline(true)
        await settle()
        XCTAssertEqual(uploads.items.first?.pending.failed, false, "«wait» is not a refusal")
        XCTAssertNil(uploads.lastNotice)

        clock.advance(by: 2_000)
        await settle()
        XCTAssertEqual(uploader.calls, 1, "not before the server's Retry-After")

        clock.advance(by: 1_000)
        await settle()
        XCTAssertEqual(uploader.calls, 2)
        XCTAssertEqual(engine.state.outbox.count, 1)
    }

    func testAServerErrorOrFullDiskIsRetriedNotFailed() async throws {
        let uploads = makeUploads()
        uploader.script(
            .failure(APIError.httpError(statusCode: 507, message: "Недостаточно места", code: nil, retryAfter: nil)),
            .failure(APIError.httpError(statusCode: 503, message: "", code: nil, retryAfter: 1)),
            FakeUploader.done(61)
        )
        _ = await uploads.add(conversation: "direct:3", picked: try picked(), replyToId: nil, owner: 2)

        uploads.setOnline(true)
        await settle()
        clock.advance(by: AttachmentUploads.retryDelayMs)
        await settle()
        clock.advance(by: 1_000)
        await settle()

        XCTAssertEqual(uploader.calls, 3)
        XCTAssertEqual(engine.state.outbox.count, 1)
    }

    func testWaitingFilesAreNotLoadedBeforeTheQueuesOwnerIsKnown() async throws {
        let rows = InMemoryPendingUploadStore()
        try await rows.putUpload(PendingUpload(clientMsgId: "k-a", conversation: "direct:3", owner: 2, createdAt: 1, name: "Алисин.pdf", size: 1, mimeType: nil, localPath: "k-a/Алисин.pdf", replyToId: nil))
        let unreadable = InMemoryDeliveryStore(StoredDelivery(me: 4))
        await unreadable.fail(.load, times: 1)
        engine = DeliveryEngine(store: unreadable, link: FakeDeliveryLink(), backend: FakeDeliveryBackend(), clock: clock)
        engine.start()
        store = rows
        let uploads = makeUploads()
        await settle()
        XCTAssertTrue(uploads.items.isEmpty, "nothing is loaded while the store cannot say whose queue it is")

        clock.advance(by: 1_000)
        await settle()
        await uploads.restored()

        XCTAssertTrue(uploads.items.isEmpty, "another account's waiting file is never loaded")
        let left = try await rows.uploads()
        XCTAssertTrue(left.isEmpty)
    }

    func testALateProgressReportNeverStrandsAFile() async throws {
        let uploads = makeUploads()
        uploader.reportProgressLate(true)
        uploader.script(.failure(URLError(.networkConnectionLost)), FakeUploader.done(70))
        _ = await uploads.add(conversation: "direct:3", picked: try picked(), replyToId: nil, owner: 2)

        uploads.setOnline(true)
        await settle()
        XCTAssertNil(uploads.items.first?.progress, "a progress report of a finished attempt is ignored")

        clock.advance(by: AttachmentUploads.retryDelayMs)
        await settle()
        XCTAssertEqual(uploader.calls, 2, "the file goes again instead of hanging at 70 %")
        XCTAssertEqual(engine.state.outbox.count, 1)
    }

    func testRowsOfAnotherAccountAreNeverRestoredUnderTheNextOne() async throws {
        let rows = InMemoryPendingUploadStore()
        let copy = AttachmentFiles(root: folder)
        let kept = try copy.keep(PickedAttachment(source: .data(Data([1, 2])), name: "Алисин.pdf", mimeType: "application/pdf"), key: "k-a")
        try await rows.putUpload(PendingUpload(clientMsgId: "k-a", conversation: "direct:3", owner: 2, createdAt: 1, name: "Алисин.pdf", size: 2, mimeType: nil, localPath: kept.path, replyToId: nil))
        // A ready engine whose model names no account yet (a fresh store).
        engine = DeliveryEngine(store: InMemoryDeliveryStore(), link: FakeDeliveryLink(), backend: FakeDeliveryBackend(), clock: clock)
        engine.start()
        await engine.idle()
        store = rows
        signedIn = 5
        let uploads = makeUploads()
        await settle()
        XCTAssertTrue(uploads.items.isEmpty, "not loaded before the queue has an owner")

        try await engine.adopt(5)
        await uploads.restored()

        XCTAssertTrue(uploads.items.isEmpty)
        let left = try await rows.uploads()
        XCTAssertTrue(left.isEmpty, "the other account's row is deleted")
        XCTAssertFalse(FileManager.default.fileExists(atPath: copy.url(kept.path).path), "with its copy")
    }

    func testRetryingOneFileOfflineSendsOnlyThatFile() async throws {
        let uploads = makeUploads()
        uploader.answer = .failure(APIError.httpError(statusCode: 415, message: "Нельзя", code: nil))
        uploads.setOnline(true)
        _ = await uploads.add(conversation: "direct:3", picked: try picked("отказ.pdf"), replyToId: nil, owner: 2)
        await settle()
        uploads.setOnline(false)
        _ = await uploads.add(conversation: "direct:3", picked: try picked("ждёт.pdf"), replyToId: nil, owner: 2)
        let refused = try XCTUnwrap(uploads.items.first { $0.pending.name == "отказ.pdf" }?.pending.clientMsgId)
        uploader.answer = FakeUploader.done(80)

        uploads.retry(refused)
        await settle()

        XCTAssertEqual(uploader.names, ["отказ.pdf", "отказ.pdf"], "«Повторить» sends that file only; the waiting one waits for the network")
    }

    func testRetriedFilesWaitingForASlotStillGoOffline() async throws {
        let uploads = makeUploads()
        uploader.answer = .failure(APIError.httpError(statusCode: 415, message: "Нельзя", code: nil))
        uploads.setOnline(true)
        for name in ["1.pdf", "2.pdf", "3.pdf"] {
            _ = await uploads.add(conversation: "direct:3", picked: try picked(name), replyToId: nil, owner: 2)
        }
        await settle()
        uploads.setOnline(false)
        let gate = TestGate()
        uploader.hold(gate)
        uploader.answer = FakeUploader.done(81)

        for item in uploads.items { uploads.retry(item.id) }
        await settle()
        XCTAssertEqual(uploader.calls, 5, "two of the three retried go at once")

        await gate.open()
        await settle()
        XCTAssertEqual(uploader.calls, 6, "the third keeps its retry when a slot frees, without a network event")
    }

    func testAWipeOfTheQueueForgetsTheFiles() async throws {
        let uploads = makeUploads()
        _ = await uploads.add(conversation: "direct:3", picked: try picked(), replyToId: nil, owner: 2)
        let pending = try XCTUnwrap(uploads.items.first?.pending)

        try await engine.reset()
        await settle()

        XCTAssertTrue(uploads.items.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: AttachmentFiles(root: folder).url(pending.localPath).path))
    }
}

/// `POST /api/files/upload` with a scripted answer; can hold uploads at a gate and counts how many
/// run at once.
final class FakeUploader: AttachmentUploader, @unchecked Sendable {
    private struct State {
        var answers: [Result<FileUploadResponse, any Error>] = []
        var answer: Result<FileUploadResponse, any Error> = .failure(URLError(.notConnectedToInternet))
        var calls = 0
        var running = 0
        var maxRunning = 0
        var gate: TestGate?
        var names: [String] = []
        /// The progress callback fires after the attempt has already returned (a late hop).
        var lateProgress = false
    }

    private let state = Locked(State())

    /// The answer of every call (after the scripted ones).
    var answer: Result<FileUploadResponse, any Error> {
        get { state.value.answer }
        set { state.withValue { $0.answer = newValue } }
    }

    /// Answers of the next calls, in order.
    func script(_ answers: Result<FileUploadResponse, any Error>...) {
        state.withValue { $0.answers += answers }
    }

    func hold(_ gate: TestGate?) {
        state.withValue { $0.gate = gate }
    }

    var calls: Int { state.value.calls }
    var names: [String] { state.value.names }
    var running: Int { state.value.running }

    func reportProgressLate(_ value: Bool) {
        state.withValue { $0.lateProgress = value }
    }
    var maxRunning: Int { state.value.maxRunning }

    func upload(file: URL, name: String, mimeType: String, progress: @escaping @Sendable (Double) -> Void) async throws -> FileUploadResponse {
        let (answer, gate, late) = state.withValue { current -> (Result<FileUploadResponse, any Error>, TestGate?, Bool) in
            current.calls += 1
            current.names.append(name)
            current.running += 1
            current.maxRunning = max(current.maxRunning, current.running)
            let next = current.answers.isEmpty ? current.answer : current.answers.removeFirst()
            return (next, current.gate, current.lateProgress)
        }
        if late {
            Task.detached {
                try? await Task.sleep(nanoseconds: 5_000_000)
                progress(0.7)
            }
        } else {
            progress(0.5)
        }
        if let gate { await gate.wait() }
        state.withValue { $0.running -= 1 }
        return try answer.get()
    }

    static func done(_ id: Int64) -> Result<FileUploadResponse, any Error> {
        .success(FileUploadResponse(id: id, originalName: "f", storedFilename: "x", fileSize: 64, mimeType: "application/pdf", url: "/api/files/download/\(id)"))
    }
}
