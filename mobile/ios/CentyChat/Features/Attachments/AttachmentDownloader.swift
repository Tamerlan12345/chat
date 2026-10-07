import Foundation

/// A download or upload that did not work out; `message` is Russian and ready for the screen.
struct AttachmentError: Error, Equatable {
    let message: String
}

/// One answer of `GET /api/files/download/{id}`: the head and the body as it arrives.
struct DownloadResponse: Sendable {
    let status: Int
    let etag: String?
    /// Length of this body (the range for a 206).
    let contentLength: Int64?
    /// `bytes start-end/size` of a 206, `bytes */size` of a 416.
    let contentRange: String?
    /// A refusal's body: plain text (`Файл не найден`) or JSON with `error`.
    let errorText: String?
    let body: AsyncThrowingStream<Data, any Error>
}

/// The request itself. Throws when the server cannot be reached.
protocol DownloadTransport: Sendable {
    func get(fileId: Int64, rangeFrom: Int64?, ifRange: String?, ifNoneMatch: String?) async throws -> DownloadResponse
}

/// Downloads attachments into the app's cache (never shared storage), one folder per file id: the
/// file under its own (sanitised) name, a `.part` while it arrives and the server's `.etag`.
///
/// Resume (`openapi.yaml` `/files/download/{id}`): a partial with a known ETag continues with
/// `Range: bytes=<have>-` + `If-Range: <etag>` (206 appends; 200 means the file changed — start
/// over; 416 — drop the partial and ask again). A finished copy is revalidated with
/// `If-None-Match` (304 keeps it) and opens offline when the server cannot be reached.
actor AttachmentDownloader {
    static let noNetwork = AppCopy.downloadNoNetwork
    static let interrupted = AppCopy.downloadInterrupted
    private static let partName = ".part"
    private static let tagName = ".etag"

    private let root: URL
    private let transport: any DownloadTransport
    /// One transfer per file id: a second tap joins it instead of writing into the same `.part`.
    private var inFlight: [Int64: Task<URL, any Error>] = [:]
    /// Bumped by `removeAll()`: a transfer of the wiped session never leaves a file behind.
    private var generation = 0

    init(root: URL, transport: any DownloadTransport) {
        self.root = root
        self.transport = transport
    }

    /// `Caches/Attachments`.
    static func defaultRoot() -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return caches.appendingPathComponent("Attachments", isDirectory: true)
    }

    /// The local copy of `fileId`. `progress` gets 0…1 (nil while the size is unknown).
    func fetch(fileId: Int64, name: String, progress: @escaping @Sendable (Double?) -> Void) async throws -> URL {
        if let running = inFlight[fileId] {
            return try await running.value
        }
        let started = generation
        let task = Task { try await self.fetch(fileId: fileId, name: name, progress: progress, retried: false, generation: started) }
        inFlight[fileId] = task
        defer { if inFlight[fileId] == task { inFlight[fileId] = nil } }
        return try await task.value
    }

    /// Every download is forgotten (sign-out, account deletion), including those still on their way.
    func removeAll() throws {
        generation += 1
        for task in inFlight.values { task.cancel() }
        inFlight.removeAll()
        if FileManager.default.fileExists(atPath: root.path) {
            try FileManager.default.removeItem(at: root)
        }
    }

    /// The session that started a transfer was wiped meanwhile: the transfer stops without touching
    /// any path. Its folder was deleted with the wipe (what it still wrote went to unlinked files), and
    /// the folder may already belong to the next session's download of the same file.
    private func checkCurrent(_ started: Int, folder: URL) throws {
        guard started != generation else { return }
        throw CancellationError()
    }

    private func fetch(fileId: Int64, name: String, progress: @escaping @Sendable (Double?) -> Void, retried: Bool, generation started: Int) async throws -> URL {
        let files = FileManager.default
        let folder = root.appendingPathComponent(String(fileId), isDirectory: true)
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        var excluded = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)

        let target = folder.appendingPathComponent(AttachmentRules.safeFileName(name))
        let part = folder.appendingPathComponent(Self.partName)
        let tag = folder.appendingPathComponent(Self.tagName)
        let etag = (try? String(contentsOf: tag, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let cached = etag != nil && files.fileExists(atPath: target.path)
        let partSize = (try? files.attributesOfItem(atPath: part.path)[.size] as? NSNumber)?.int64Value ?? 0
        let resumeFrom: Int64? = !cached && etag != nil && partSize > 0 ? partSize : nil
        if !cached && resumeFrom == nil { try? files.removeItem(at: part) }

        let response: DownloadResponse
        do {
            response = try await transport.get(
                fileId: fileId,
                rangeFrom: resumeFrom,
                ifRange: resumeFrom != nil ? etag : nil,
                ifNoneMatch: cached ? etag : nil
            )
        } catch {
            try checkCurrent(started, folder: folder)
            if cached { return target }
            throw AttachmentError(message: Self.noNetwork)
        }
        try checkCurrent(started, folder: folder)

        switch response.status {
        case 304 where cached:
            return target
        case 200:
            return try await write(response, folder: folder, target: target, part: part, tag: tag, offset: 0, progress: progress, generation: started)
        case 206 where resumeFrom != nil:
            if Self.startOf(response.contentRange) == resumeFrom, let resumeFrom {
                return try await write(response, folder: folder, target: target, part: part, tag: tag, offset: resumeFrom, progress: progress, generation: started)
            }
            // Not the range asked for (a proxy, a changed file): appending would corrupt the copy.
            if !retried {
                try? files.removeItem(at: part)
                try? files.removeItem(at: tag)
                return try await fetch(fileId: fileId, name: name, progress: progress, retried: true, generation: started)
            }
        case 416 where !retried:
            try? files.removeItem(at: part)
            try? files.removeItem(at: tag)
            return try await fetch(fileId: fileId, name: name, progress: progress, retried: true, generation: started)
        case 500...599 where cached:
            return target
        case 403, 404:
            try? files.removeItem(at: folder)
        default:
            break
        }
        throw AttachmentError(message: Self.refusalText(response))
    }

    private func write(
        _ response: DownloadResponse,
        folder: URL,
        target: URL,
        part: URL,
        tag: URL,
        offset: Int64,
        progress: @Sendable (Double?) -> Void,
        generation started: Int
    ) async throws -> URL {
        let files = FileManager.default
        let total: Int64? = offset > 0
            ? Self.totalOf(response.contentRange) ?? response.contentLength.map { $0 + offset }
            : response.contentLength
        if offset == 0 {
            // A whole body replaces whatever was here: the old copy and an unrelated partial.
            for item in (try? files.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] {
                try? files.removeItem(at: item)
            }
            files.createFile(atPath: part.path, contents: nil)
        }
        if let etag = response.etag {
            try? etag.write(to: tag, atomically: true, encoding: .utf8)
        } else {
            try? files.removeItem(at: tag)
        }

        guard let handle = try? FileHandle(forWritingTo: part) else { throw AttachmentError(message: Self.interrupted) }
        defer { try? handle.close() }
        var written = offset
        var lastStep = -1
        progress(total.map { $0 > 0 ? min(1, Double(written) / Double($0)) : 0 })
        do {
            try handle.seekToEnd()
            for try await chunk in response.body {
                try Task.checkCancellation()
                try handle.write(contentsOf: chunk)
                written += Int64(chunk.count)
                if let total, total > 0 {
                    let step = Int(written * 100 / total)
                    if step != lastStep {
                        lastStep = step
                        progress(min(1, Double(written) / Double(total)))
                    }
                }
            }
        } catch is CancellationError {
            try checkCurrent(started, folder: folder)
            throw CancellationError()
        } catch {
            try checkCurrent(started, folder: folder)
            // What arrived stays as the partial; the next tap continues from there.
            throw AttachmentError(message: Self.interrupted)
        }
        try checkCurrent(started, folder: folder)
        if let total, written != total { throw AttachmentError(message: Self.interrupted) }
        try? handle.close()
        try? files.removeItem(at: target)
        do {
            try files.moveItem(at: part, to: target)
        } catch {
            throw AttachmentError(message: Self.interrupted)
        }
        progress(1)
        return target
    }

    private static func refusalText(_ response: DownloadResponse) -> String {
        refusalText(status: response.status, errorText: response.errorText)
    }

    /// The server's words when it gave some, otherwise ours for the status.
    static func refusalText(status: Int, errorText: String?) -> String {
        let raw = (errorText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.hasPrefix("{"), let message = JSONValue.parse(raw)?["error"]?.string, !message.isEmpty {
            return message
        }
        if !raw.isEmpty, !raw.hasPrefix("{"), !raw.hasPrefix("<"), raw.count <= 300 {
            return raw
        }
        switch status {
        case 403: return AppCopy.downloadForbidden
        case 404: return AppCopy.downloadNotFound
        // An HTTP code means nothing to an employee (`download.failed`).
        default: return AppCopy.downloadFailed
        }
    }

    /// First byte of `bytes 100-199/1000`.
    static func startOf(_ contentRange: String?) -> Int64? {
        guard var text = contentRange?.trimmingCharacters(in: .whitespaces), text.hasPrefix("bytes") else { return nil }
        text.removeFirst("bytes".count)
        return text.split(separator: "-").first.flatMap { Int64($0.trimmingCharacters(in: .whitespaces)) }
    }

    /// Total size from `bytes 100-199/1000`.
    static func totalOf(_ contentRange: String?) -> Int64? {
        guard let slash = contentRange?.split(separator: "/").last, contentRange?.contains("/") == true else { return nil }
        return Int64(slash.trimmingCharacters(in: .whitespaces))
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
