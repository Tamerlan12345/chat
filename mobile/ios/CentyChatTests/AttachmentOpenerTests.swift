import Foundation
import XCTest
@testable import CentyChat

/// A tap on an attachment: an image opens in the in-app viewer; a file downloads (progress and
/// failure on its tile) and opens in Quick Look only when its extension's type is safe.
@MainActor
final class AttachmentOpenerTests: XCTestCase {
    private var root: URL!
    private let types = ["pdf": "application/pdf", "html": "text/html", "png": "image/png"]

    override func setUp() async throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true).appendingPathComponent("opener-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func opener(_ steps: [ScriptedDownloads.Step]) -> AttachmentOpener {
        let types = self.types
        return AttachmentOpener(
            downloader: AttachmentDownloader(root: root, transport: ScriptedDownloads(steps)),
            typeForExtension: { types[$0] }
        )
    }

    private func file(_ name: String, id: Int64 = 42) -> MessageAttachment {
        MessageAttachment(fileId: id, name: name, size: 5, mimeType: "text/html", isImage: AttachmentRules.isImage(name: name, mimeType: nil), width: nil, height: nil, localFile: nil)
    }

    private func waitForTransfer(_ opener: AttachmentOpener, _ id: Int64) async {
        for _ in 0..<100 {
            if case .running? = opener.transfers[id] {
                try? await Task.sleep(nanoseconds: 5_000_000)
            } else if opener.transfers[id] == nil {
                try? await Task.sleep(nanoseconds: 5_000_000)
            } else {
                return
            }
        }
    }

    func testASafeFileOpensInQuickLookAfterItsDownload() async {
        let opener = opener([.answer(status: 200, etag: "\"a\"", body: [Data("%PDF-".utf8)], length: 5)])

        opener.open(file("Договор.pdf"))
        await waitForTransfer(opener, 42)

        XCTAssertEqual(opener.preview?.url.lastPathComponent, "Договор.pdf")
        XCTAssertNil(opener.shareable)
    }

    func testAFileWhoseTypeIsNotSafeIsOfferedToOtherAppsInstead() async {
        // The sender wrote "text/html"; the extension decides, and HTML is not shown inside the app.
        let opener = opener([.answer(status: 200, etag: "\"a\"", body: [Data("<html>".utf8)], length: 6)])

        opener.open(file("page.html"))
        await waitForTransfer(opener, 42)

        XCTAssertNil(opener.preview)
        XCTAssertEqual(opener.shareable?.url.lastPathComponent, "page.html")
    }

    func testAnImageOpensInTheViewerAndDownloadsUnderIt() async {
        let opener = opener([.answer(status: 200, etag: "\"a\"", body: [Data([1, 2, 3])], length: 3)])
        let image = MessageAttachment(fileId: 7, name: "фото.png", size: 3, mimeType: nil, isImage: true, width: 10, height: 10, localFile: nil)

        opener.open(image)
        XCTAssertEqual(opener.viewer, image, "the viewer opens at once, with the thumbnail first")
        await waitForTransfer(opener, 7)

        guard case .ready(let url)? = opener.transfers[7] else { return XCTFail("the full picture must be downloaded") }
        XCTAssertEqual(url.lastPathComponent, "фото.png")
        XCTAssertNil(opener.preview)
    }

    func testAFailedDownloadSaysWhyAndATapTriesAgain() async {
        let opener = opener([.unreachable, .answer(status: 200, etag: nil, body: [Data("ok".utf8)], length: 2)])

        opener.open(file("Акт.pdf"))
        await waitForTransfer(opener, 42)
        XCTAssertEqual(opener.transfers[42], .failed(AttachmentDownloader.noNetwork))
        XCTAssertEqual(opener.notice, AttachmentDownloader.noNetwork)

        opener.open(file("Акт.pdf"))
        await waitForTransfer(opener, 42)
        XCTAssertNotNil(opener.preview)
    }

    func testALocalCopyOpensWithoutADownload() async throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let local = root.appendingPathComponent("Акт.pdf")
        try Data("%PDF-".utf8).write(to: local)
        let opener = opener([])

        opener.open(MessageAttachment(fileId: nil, name: "Акт.pdf", size: 5, mimeType: nil, isImage: false, width: nil, height: nil, localFile: local))

        XCTAssertEqual(opener.preview?.url, local)
    }
}
