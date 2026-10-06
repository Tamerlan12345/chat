import Foundation
import XCTest
@testable import CentyChat

/// Downloads into the app's cache with resume (`openapi.yaml` `/files/download/{id}`): `Range` +
/// `If-Range` continue a partial, `If-None-Match` revalidates a finished copy.
final class AttachmentDownloaderTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("downloader-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func bytes(_ count: Int, from start: Int = 0) -> Data {
        Data((start..<(start + count)).map { UInt8($0 % 251) })
    }

    func testAFreshDownloadIsStoredUnderItsNameWithTheServersTag() async throws {
        let transport = ScriptedDownloads([.answer(status: 200, etag: "\"v1\"", body: [bytes(10), bytes(6, from: 10)], length: 16)])
        let downloader = AttachmentDownloader(root: root, transport: transport)
        let progress = Locked<[Double?]>([])

        let file = try await downloader.fetch(fileId: 7, name: "Отчёт.pdf") { value in progress.withValue { $0.append(value) } }

        XCTAssertEqual(file.lastPathComponent, "Отчёт.pdf")
        XCTAssertEqual(try Data(contentsOf: file), bytes(16))
        XCTAssertEqual(progress.value.last ?? nil, 1)
        XCTAssertEqual(transport.requests.first, Request(rangeFrom: nil, ifRange: nil, ifNoneMatch: nil))
    }

    func testAnInterruptedDownloadContinuesWhereItStopped() async throws {
        let transport = ScriptedDownloads([
            .answer(status: 200, etag: "\"v1\"", body: [bytes(10)], length: 16, failsAfterBody: true),
            .answer(status: 206, etag: "\"v1\"", body: [bytes(6, from: 10)], length: 6, contentRange: "bytes 10-15/16"),
        ])
        let downloader = AttachmentDownloader(root: root, transport: transport)

        do {
            _ = try await downloader.fetch(fileId: 7, name: "video.mp4") { _ in }
            XCTFail("the broken transfer must be reported")
        } catch let error as AttachmentError {
            XCTAssertEqual(error.message, AttachmentDownloader.interrupted)
        }
        let file = try await downloader.fetch(fileId: 7, name: "video.mp4") { _ in }

        XCTAssertEqual(transport.requests.last, Request(rangeFrom: 10, ifRange: "\"v1\"", ifNoneMatch: nil))
        XCTAssertEqual(try Data(contentsOf: file), bytes(16), "the resumed range is appended to the partial")
    }

    func testARangeThatDoesNotStartWhereThePartialEndsIsDownloadedWhole() async throws {
        let transport = ScriptedDownloads([
            .answer(status: 200, etag: "\"v1\"", body: [bytes(10)], length: 16, failsAfterBody: true),
            .answer(status: 206, etag: "\"v1\"", body: [bytes(6, from: 4)], length: 6, contentRange: "bytes 4-9/16"),
            .answer(status: 200, etag: "\"v1\"", body: [bytes(16)], length: 16),
        ])
        let downloader = AttachmentDownloader(root: root, transport: transport)
        _ = try? await downloader.fetch(fileId: 7, name: "a.zip") { _ in }

        let file = try await downloader.fetch(fileId: 7, name: "a.zip") { _ in }

        XCTAssertEqual(transport.requests.last, Request(rangeFrom: nil, ifRange: nil, ifNoneMatch: nil))
        XCTAssertEqual(try Data(contentsOf: file), bytes(16), "appending the wrong range would corrupt the copy")
    }

    func testAFileThatChangedAnswersWholeAndReplacesThePartial() async throws {
        let transport = ScriptedDownloads([
            .answer(status: 200, etag: "\"v1\"", body: [bytes(10)], length: 16, failsAfterBody: true),
            .answer(status: 200, etag: "\"v2\"", body: [bytes(12, from: 100)], length: 12),
        ])
        let downloader = AttachmentDownloader(root: root, transport: transport)
        _ = try? await downloader.fetch(fileId: 7, name: "a.txt") { _ in }

        let file = try await downloader.fetch(fileId: 7, name: "a.txt") { _ in }

        XCTAssertEqual(try Data(contentsOf: file), bytes(12, from: 100))
    }

    func testARangeTheServerCannotServeDropsThePartialAndAsksAgain() async throws {
        let transport = ScriptedDownloads([
            .answer(status: 200, etag: "\"v1\"", body: [bytes(10)], length: 16, failsAfterBody: true),
            .answer(status: 416, etag: nil, body: [], length: 0, contentRange: "bytes */8"),
            .answer(status: 200, etag: "\"v3\"", body: [bytes(8)], length: 8),
        ])
        let downloader = AttachmentDownloader(root: root, transport: transport)
        _ = try? await downloader.fetch(fileId: 7, name: "a.txt") { _ in }

        let file = try await downloader.fetch(fileId: 7, name: "a.txt") { _ in }

        XCTAssertEqual(try Data(contentsOf: file), bytes(8))
        XCTAssertEqual(transport.requests.last, Request(rangeFrom: nil, ifRange: nil, ifNoneMatch: nil))
    }

    func testAFinishedCopyIsRevalidatedAndOpensWithoutANetwork() async throws {
        let transport = ScriptedDownloads([
            .answer(status: 200, etag: "\"v1\"", body: [bytes(5)], length: 5),
            .answer(status: 304, etag: "\"v1\"", body: [], length: 0),
            .unreachable,
        ])
        let downloader = AttachmentDownloader(root: root, transport: transport)
        _ = try await downloader.fetch(fileId: 9, name: "p.png") { _ in }

        let revalidated = try await downloader.fetch(fileId: 9, name: "p.png") { _ in }
        let offline = try await downloader.fetch(fileId: 9, name: "p.png") { _ in }

        XCTAssertEqual(transport.requests[1], Request(rangeFrom: nil, ifRange: nil, ifNoneMatch: "\"v1\""))
        XCTAssertEqual(try Data(contentsOf: revalidated), bytes(5))
        XCTAssertEqual(try Data(contentsOf: offline), bytes(5))
    }

    func testAFileThatIsGoneIsForgottenAndTheServersWordsAreShown() async throws {
        let transport = ScriptedDownloads([
            .answer(status: 200, etag: "\"v1\"", body: [bytes(5)], length: 5),
            .answer(status: 404, etag: nil, body: [], length: 0, errorText: "Файл не найден"),
        ])
        let downloader = AttachmentDownloader(root: root, transport: transport)
        _ = try await downloader.fetch(fileId: 9, name: "p.png") { _ in }

        do {
            _ = try await downloader.fetch(fileId: 9, name: "p.png") { _ in }
            XCTFail("a deleted file must not open")
        } catch let error as AttachmentError {
            XCTAssertEqual(error.message, "Файл не найден")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("9").path))
    }

    func testNoNetworkWithoutACopySaysSo() async throws {
        let downloader = AttachmentDownloader(root: root, transport: ScriptedDownloads([.unreachable]))

        do {
            _ = try await downloader.fetch(fileId: 9, name: "p.png") { _ in }
            XCTFail("nothing to open")
        } catch let error as AttachmentError {
            XCTAssertEqual(error.message, AttachmentDownloader.noNetwork)
        }
    }

    func testRemoveAllForgetsEveryDownload() async throws {
        let downloader = AttachmentDownloader(root: root, transport: ScriptedDownloads([.answer(status: 200, etag: nil, body: [bytes(3)], length: 3)]))
        _ = try await downloader.fetch(fileId: 1, name: "a.txt") { _ in }

        try await downloader.removeAll()

        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }
}

struct Request: Equatable {
    let rangeFrom: Int64?
    let ifRange: String?
    let ifNoneMatch: String?
}

/// Answers download requests from a script, in order; records what was asked.
final class ScriptedDownloads: DownloadTransport, @unchecked Sendable {
    enum Step {
        case answer(status: Int, etag: String?, body: [Data], length: Int64?, contentRange: String? = nil, errorText: String? = nil, failsAfterBody: Bool = false)
        case unreachable
    }

    private let steps: Locked<[Step]>
    private let asked = Locked<[Request]>([])

    init(_ steps: [Step]) {
        self.steps = Locked(steps)
    }

    var requests: [Request] { asked.value }

    func get(fileId: Int64, rangeFrom: Int64?, ifRange: String?, ifNoneMatch: String?) async throws -> DownloadResponse {
        asked.withValue { $0.append(Request(rangeFrom: rangeFrom, ifRange: ifRange, ifNoneMatch: ifNoneMatch)) }
        let step = steps.withValue { $0.isEmpty ? Step.unreachable : $0.removeFirst() }
        switch step {
        case .unreachable:
            throw URLError(.notConnectedToInternet)
        case .answer(let status, let etag, let body, let length, let contentRange, let errorText, let failsAfterBody):
            let stream = AsyncThrowingStream<Data, any Error> { continuation in
                for chunk in body { continuation.yield(chunk) }
                continuation.finish(throwing: failsAfterBody ? URLError(.networkConnectionLost) : nil)
            }
            return DownloadResponse(status: status, etag: etag, contentLength: length, contentRange: contentRange, errorText: errorText, body: stream)
        }
    }
}

/// One download per file at a time, and none outlives a wipe.
final class AttachmentDownloaderConcurrencyTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("downloader-c-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testTwoTapsOnTheSameFileShareOneDownload() async throws {
        let gate = TestGate()
        let transport = GatedDownloads(gate: gate, body: Data("0123456789".utf8))
        let downloader = AttachmentDownloader(root: root, transport: transport)

        async let first = downloader.fetch(fileId: 3, name: "a.txt") { _ in }
        async let second = downloader.fetch(fileId: 3, name: "a.txt") { _ in }
        try await Task.sleep(nanoseconds: 50_000_000)
        await gate.open()
        let (a, b) = try await (first, second)

        XCTAssertEqual(transport.requests, 1, "no second request writing into the same .part")
        XCTAssertEqual(a, b)
        XCTAssertEqual(try Data(contentsOf: a), Data("0123456789".utf8))
    }

    func testADownloadThatFinishesAfterAWipeLeavesNoFile() async throws {
        let gate = TestGate()
        let downloader = AttachmentDownloader(root: root, transport: GatedDownloads(gate: gate, body: Data("secret".utf8)))

        async let fetched = downloader.fetch(fileId: 4, name: "b.txt") { _ in }
        try await Task.sleep(nanoseconds: 50_000_000)
        try await downloader.removeAll()
        await gate.open()

        do {
            _ = try await fetched
            XCTFail("a download of the signed-out session must not be handed out")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("4").path), "nothing of it is left on disk")
    }
}

/// A 200 whose body waits for the gate.
final class GatedDownloads: DownloadTransport, @unchecked Sendable {
    private let gate: TestGate
    private let body: Data
    private let asked = Locked(0)

    init(gate: TestGate, body: Data) {
        self.gate = gate
        self.body = body
    }

    var requests: Int { asked.value }

    func get(fileId: Int64, rangeFrom: Int64?, ifRange: String?, ifNoneMatch: String?) async throws -> DownloadResponse {
        asked.withValue { $0 += 1 }
        let gate = self.gate
        let body = self.body
        let stream = AsyncThrowingStream<Data, any Error> { continuation in
            Task {
                await gate.wait()
                continuation.yield(body)
                continuation.finish()
            }
        }
        return DownloadResponse(status: 200, etag: "\"g\"", contentLength: Int64(body.count), contentRange: nil, errorText: nil, body: stream)
    }
}

/// A transfer of a wiped session must not leave its file, nor touch the next session's download of
/// the same file.
final class AttachmentDownloaderGenerationTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("downloader-g-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testAStaleTransferNeitherLeavesItsFileNorBreaksTheNextSessionsDownload() async throws {
        let staleAnswer = TestGate()
        let freshBody = TestGate()
        let transport = SequencedDownloads([
            .init(head: staleAnswer, body: nil, data: Data("старое".utf8)),
            .init(head: nil, body: freshBody, data: Data("новое".utf8)),
        ])
        let downloader = AttachmentDownloader(root: root, transport: transport)

        // The old session asks; its answer is late.
        async let old = downloader.fetch(fileId: 5, name: "c.txt") { _ in }
        try await Task.sleep(nanoseconds: 50_000_000)
        try await downloader.removeAll()
        // The next session downloads the same file; its partial is on disk while the old answer lands.
        async let new = downloader.fetch(fileId: 5, name: "c.txt") { _ in }
        try await Task.sleep(nanoseconds: 50_000_000)
        await staleAnswer.open()
        do {
            _ = try await old
            XCTFail("the wiped session's download must not be handed out")
        } catch {}

        await freshBody.open()
        let file = try await new
        XCTAssertEqual(try Data(contentsOf: file), Data("новое".utf8), "the next session's download is intact")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path).filter { !$0.hasPrefix(".") }, ["c.txt"])
    }
}

/// Answers each request in order; its head and its body can each wait for a gate.
final class SequencedDownloads: DownloadTransport, @unchecked Sendable {
    struct Step {
        let head: TestGate?
        let body: TestGate?
        let data: Data
    }

    private let steps: Locked<[Step]>

    init(_ steps: [Step]) {
        self.steps = Locked(steps)
    }

    func get(fileId: Int64, rangeFrom: Int64?, ifRange: String?, ifNoneMatch: String?) async throws -> DownloadResponse {
        guard let step = steps.withValue({ $0.isEmpty ? nil : $0.removeFirst() }) else {
            throw URLError(.notConnectedToInternet)
        }
        if let head = step.head { await head.wait() }
        let gate = step.body
        let data = step.data
        let stream = AsyncThrowingStream<Data, any Error> { continuation in
            Task {
                if let gate { await gate.wait() }
                continuation.yield(data)
                continuation.finish()
            }
        }
        return DownloadResponse(status: 200, etag: "\"s\"", contentLength: Int64(data.count), contentRange: nil, errorText: nil, body: stream)
    }
}
