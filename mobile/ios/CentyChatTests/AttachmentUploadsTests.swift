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

/// `POST /api/files/upload` with a scripted answer.
final class FakeUploader: AttachmentUploader, @unchecked Sendable {
    private let state = Locked<(answer: Result<FileUploadResponse, any Error>, calls: Int)>((.failure(URLError(.notConnectedToInternet)), 0))

    var answer: Result<FileUploadResponse, any Error> {
        get { state.value.answer }
        set { state.withValue { $0.answer = newValue } }
    }

    var calls: Int { state.value.calls }

    func upload(file: URL, name: String, mimeType: String, progress: @escaping @Sendable (Double) -> Void) async throws -> FileUploadResponse {
        let answer = state.withValue { current -> Result<FileUploadResponse, any Error> in
            current.calls += 1
            return current.answer
        }
        progress(0.5)
        return try answer.get()
    }
}
