import Foundation
import XCTest
@testable import CentyChat

/// What a file is, what may be sent, and which type another viewer may open it as.
final class AttachmentRulesTests: XCTestCase {
    /// The server's `SAFE_DOWNLOAD_TYPES` (server/src/api/index.js `safeDownloadType`), copied here so
    /// a drift of the app's mirror is caught.
    private let serverSafeTypes: Set<String> = [
        "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
        "application/pdf", "text/plain", "text/csv",
        "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/webm",
        "video/mp4", "video/webm", "video/quicktime",
        "application/zip", "application/x-7z-compressed", "application/vnd.rar", "application/x-rar-compressed",
    ]

    func testTheSafeTypesMirrorTheServerExactly() {
        XCTAssertEqual(AttachmentRules.safeOpenTypes, serverSafeTypes)
    }

    func testTheExtensionFollowsTheServersRule() {
        XCTAssertEqual(AttachmentRules.extensionOf("Отчёт.PDF"), "pdf")
        XCTAssertEqual(AttachmentRules.extensionOf("archive.tar.gz"), "gz")
        XCTAssertEqual(AttachmentRules.extensionOf(".bashrc"), "", "a leading dot is no extension")
        XCTAssertEqual(AttachmentRules.extensionOf("README"), "")
        XCTAssertEqual(AttachmentRules.extensionOf("name."), "")
    }

    func testTheOpenTypeComesFromTheExtensionNeverFromTheSender() {
        let types = ["pdf": "application/pdf", "html": "text/html", "svg": "image/svg+xml", "txt": "text/plain"]
        let lookup: (String) -> String? = { types[$0] }

        XCTAssertEqual(AttachmentRules.openType(forName: "договор.pdf", typeForExtension: lookup), "application/pdf")
        XCTAssertEqual(AttachmentRules.openType(forName: "notes.txt", typeForExtension: lookup), "text/plain")
        XCTAssertNil(AttachmentRules.openType(forName: "page.html", typeForExtension: lookup), "HTML is not opened inside the app")
        XCTAssertNil(AttachmentRules.openType(forName: "logo.svg", typeForExtension: lookup), "SVG is a document with scripts, not an image")
        XCTAssertNil(AttachmentRules.openType(forName: "no-extension", typeForExtension: lookup))
    }

    func testOnlyFormatsTheServerThumbnailsAreDrawnAsImages() {
        XCTAssertTrue(AttachmentRules.isImage(name: "photo.JPG", mimeType: nil))
        XCTAssertTrue(AttachmentRules.isImage(name: "anim.gif", mimeType: "application/octet-stream"))
        XCTAssertFalse(AttachmentRules.isImage(name: "logo.svg", mimeType: "image/svg+xml"))
        XCTAssertFalse(AttachmentRules.isImage(name: "scan.heic", mimeType: "image/heic"))
        XCTAssertTrue(AttachmentRules.isImage(name: "без-расширения", mimeType: "image/png"), "no extension: the type decides")
    }

    func testAFileIsCheckedBeforeItIsQueued() {
        let policy = FilePolicyEffectiveResponse(enabled: true, allowed: ["pdf", ".JPG", "png"])

        XCTAssertNil(AttachmentRules.problem(name: "акт.pdf", size: 1_024, policy: policy))
        XCTAssertNil(AttachmentRules.problem(name: "фото.jpg", size: 1_024, policy: policy))
        XCTAssertEqual(AttachmentRules.problem(name: "пусто.pdf", size: 0, policy: policy), "Файл пустой")
        XCTAssertEqual(AttachmentRules.problem(name: "big.pdf", size: 101 * 1_024 * 1_024, policy: policy), "Файл больше 100 МБ — такой файл загрузить нельзя")
        XCTAssertEqual(AttachmentRules.problem(name: "run.exe", size: 10, policy: policy), "Файлы .exe к отправке не разрешены")
        XCTAssertEqual(AttachmentRules.problem(name: "README", size: 10, policy: policy), "У файла нет расширения")
        XCTAssertNil(AttachmentRules.problem(name: "run.exe", size: 10, policy: nil), "an unknown policy is left to the server")
        XCTAssertNil(AttachmentRules.problem(name: "run.exe", size: 10, policy: FilePolicyEffectiveResponse(enabled: false, allowed: [])))
    }

    func testTheServersRefusalIsShownInItsOwnWords() {
        XCTAssertEqual(
            AttachmentRules.failureText(APIError.httpError(statusCode: 415, message: "Файлы .exe к отправке не разрешены", code: "ext-not-allowed")),
            "Файлы .exe к отправке не разрешены"
        )
        XCTAssertEqual(AttachmentRules.failureText(APIError.httpError(statusCode: 413, message: "", code: nil)), "Сервер не принял файл")
        XCTAssertTrue(AttachmentRules.isTransportFailure(APIError.noConnection))
        XCTAssertTrue(AttachmentRules.isTransportFailure(APIError.unauthorized), "a session to renew is not the server refusing the file")
        XCTAssertTrue(AttachmentRules.isTransportFailure(URLError(.notConnectedToInternet)))
        XCTAssertFalse(AttachmentRules.isTransportFailure(APIError.httpError(statusCode: 415, message: "нет", code: nil)))
    }

    func testTheMetadataIsTheDesktopsShape() {
        let metadata = AttachmentRules.metadata(fileId: 42, size: 2_048, mimeType: "image/png", width: 640, height: 480)

        XCTAssertEqual(metadata, [
            "file_id": 42,
            "size": 2_048,
            "mimeType": "image/png",
            "url": "/api/files/download/42",
            "width": 640,
            "height": 480,
        ])
    }

    func testAFileNameStaysInsideItsFolder() {
        XCTAssertEqual(AttachmentRules.safeFileName("../../etc/passwd"), "_.._.._etc_passwd")
        XCTAssertEqual(AttachmentRules.safeFileName("  "), "файл")
        XCTAssertEqual(AttachmentRules.safeFileName(".part"), "_.part", "never one of the service files")
        XCTAssertEqual(AttachmentRules.safeFileName("Отчёт: итоги?.pdf"), "Отчёт_ итоги_.pdf")
        XCTAssertLessThanOrEqual(AttachmentRules.safeFileName(String(repeating: "я", count: 300) + ".docx").count, 120)
        XCTAssertTrue(AttachmentRules.safeFileName(String(repeating: "я", count: 300) + ".docx").hasSuffix(".docx"))
    }
}

/// The multipart body of `POST /api/files/upload` is written to a file, so the upload streams from
/// disk (flat memory, real progress).
final class MultipartFileTests: XCTestCase {
    func testTheBodyIsTheFileBetweenItsPartHeaderAndTheClosingBoundary() throws {
        let folder = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true).appendingPathComponent("mp-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let source = folder.appendingPathComponent("src.bin")
        let payload = Data((0..<200_000).map { UInt8($0 % 256) })
        try payload.write(to: source)

        let body = try MultipartFile.write(file: source, fieldName: "file", fileName: "Акт \"1\".pdf", mimeType: "application/pdf", boundary: "B0UND", in: folder)

        let written = try Data(contentsOf: body)
        let head = Data("--B0UND\r\nContent-Disposition: form-data; name=\"file\"; filename=\"Акт 1.pdf\"\r\nContent-Type: application/pdf\r\n\r\n".utf8)
        let tail = Data("\r\n--B0UND--\r\n".utf8)
        XCTAssertEqual(written, head + payload + tail)
    }

    func testOnlyTransportFailuresAndBusyAnswersAreRetried() {
        XCTAssertEqual(AttachmentRules.retryDelayMs(APIError.noConnection), AttachmentUploads.retryDelayMs)
        XCTAssertEqual(AttachmentRules.retryDelayMs(APIError.httpError(statusCode: 429, message: "Дождитесь окончания текущих загрузок", code: nil, retryAfter: 7)), 7_000)
        XCTAssertEqual(AttachmentRules.retryDelayMs(APIError.httpError(statusCode: 507, message: "", code: nil, retryAfter: nil)), AttachmentUploads.retryDelayMs)
        XCTAssertEqual(AttachmentRules.retryDelayMs(APIError.httpError(statusCode: 502, message: "", code: nil, retryAfter: nil)), AttachmentUploads.retryDelayMs)
        XCTAssertNil(AttachmentRules.retryDelayMs(APIError.httpError(statusCode: 415, message: "Файлы .exe к отправке не разрешены", code: "ext-not-allowed")))
        XCTAssertNil(AttachmentRules.retryDelayMs(APIError.httpError(statusCode: 413, message: "Файл слишком большой", code: nil)))
    }
}
