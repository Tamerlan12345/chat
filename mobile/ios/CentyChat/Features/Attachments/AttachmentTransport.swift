import Foundation

/// The shared on-disk store of the delivery model and its waiting files.
enum LiveDelivery {
    static let store = SwiftDataDeliveryStore(directory: SwiftDataDeliveryStore.defaultDirectory())
}

/// A request is never followed to another address: the Bearer token goes only to the configured
/// server, and a redirect could carry it elsewhere.
final class RedirectRefusal: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
        nil
    }
}

/// `POST /api/files/upload` through `APIClient` (Bearer, one token refresh).
struct APIAttachmentUploader: AttachmentUploader {
    let client: APIClient
    var offline: @Sendable () -> Bool = { LaunchTestFixture.deliveryOffline }

    func upload(file: URL, name: String, mimeType: String, progress: @escaping @Sendable (Double) -> Void) async throws -> FileUploadResponse {
        if offline() { throw URLError(.notConnectedToInternet) }
        let data: Data
        do {
            data = try Data(contentsOf: file, options: .mappedIfSafe)
        } catch {
            throw AttachmentError(message: String(localized: "Файл недоступен — удалите его и выберите снова"))
        }
        progress(0)
        let response = try await client.uploadFile(fileData: data, fileName: name, mimeType: mimeType)
        progress(1)
        return response
    }
}

/// `GET /api/files/download/{id}` over HTTPS to the configured server only, with the session's
/// Bearer token, `Range`/`If-Range`/`If-None-Match`, redirects refused; the body streams to disk.
struct URLSessionDownloadTransport: DownloadTransport {
    let environment: ServerEnvironment
    let token: @Sendable () -> String?
    private let session: URLSession
    private let refusal = RedirectRefusal()

    init(environment: ServerEnvironment, token: @escaping @Sendable () -> String?) {
        self.environment = environment
        self.token = token
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration)
    }

    func get(fileId: Int64, rangeFrom: Int64?, ifRange: String?, ifNoneMatch: String?) async throws -> DownloadResponse {
        guard let url = URL(string: "/api/files/download/\(fileId)", relativeTo: environment.serverURL)?.absoluteURL,
              url.scheme?.lowercased() == "https",
              ServerEnvironment.origin(of: url) == environment.origin,
              let token = token() else {
            throw URLError(.userAuthenticationRequired)
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let rangeFrom { request.setValue("bytes=\(rangeFrom)-", forHTTPHeaderField: "Range") }
        if let ifRange { request.setValue(ifRange, forHTTPHeaderField: "If-Range") }
        if let ifNoneMatch { request.setValue(ifNoneMatch, forHTTPHeaderField: "If-None-Match") }

        let (head, body) = try await Self.stream(request, session: session, delegate: refusal)
        let status = head.statusCode
        var errorText: String?
        var stream = body
        if status != 200 && status != 206 {
            // A refusal's body is short text; read it and hand over an empty body.
            var text = Data()
            for try await chunk in body where text.count < 4_096 { text.append(chunk) }
            errorText = String(decoding: text, as: UTF8.self)
            stream = AsyncThrowingStream { $0.finish() }
        }
        return DownloadResponse(
            status: status,
            etag: head.value(forHTTPHeaderField: "ETag"),
            contentLength: head.expectedContentLength >= 0 ? head.expectedContentLength : nil,
            contentRange: head.value(forHTTPHeaderField: "Content-Range"),
            errorText: errorText,
            body: stream
        )
    }

    /// Starts the request; returns once the head arrived, the body follows in 64 KB chunks.
    static func stream(_ request: URLRequest, session: URLSession, delegate: RedirectRefusal) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        let (body, sink) = AsyncThrowingStream<Data, any Error>.makeStream()
        let head: HTTPURLResponse = try await withCheckedThrowingContinuation { headContinuation in
            let task = Task {
                var delivered = false
                do {
                    let (bytes, response) = try await session.bytes(for: request, delegate: delegate)
                    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                    delivered = true
                    headContinuation.resume(returning: http)
                    var buffer = Data()
                    buffer.reserveCapacity(65_536)
                    for try await byte in bytes {
                        buffer.append(byte)
                        if buffer.count >= 65_536 {
                            sink.yield(buffer)
                            buffer.removeAll(keepingCapacity: true)
                        }
                    }
                    if !buffer.isEmpty { sink.yield(buffer) }
                    sink.finish()
                } catch {
                    if delivered {
                        sink.finish(throwing: error)
                    } else {
                        headContinuation.resume(throwing: error)
                        sink.finish(throwing: error)
                    }
                }
            }
            sink.onTermination = { _ in task.cancel() }
        }
        return (head, body)
    }
}

/// Image previews: `/api/files/thumb/{id}?size=m&format=jpeg` from the configured server with the
/// session's token, kept in memory and forgotten when the session ends.
actor AttachmentThumbnails {
    private let environment: ServerEnvironment
    private let token: @Sendable () -> String?
    private let session: URLSession?
    private let refusal = RedirectRefusal()
    private var cache: [Int64: Data] = [:]
    private var order: [Int64] = []
    private var inFlight: [Int64: Task<Data?, Never>] = [:]
    private var generation = 0
    private static let capacity = 120

    init(environment: ServerEnvironment, token: @escaping @Sendable () -> String?, live: Bool) {
        self.environment = environment
        self.token = token
        if live {
            let configuration = URLSessionConfiguration.default
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.timeoutIntervalForRequest = 20
            session = URLSession(configuration: configuration)
        } else {
            session = nil
        }
    }

    func cached(_ fileId: Int64) -> Data? {
        cache[fileId]
    }

    func data(for fileId: Int64) async -> Data? {
        if let hit = cache[fileId] { return hit }
        if let running = inFlight[fileId] { return await running.value }
        guard let session,
              let url = URL(string: "/api/files/thumb/\(fileId)?size=m&format=jpeg", relativeTo: environment.serverURL)?.absoluteURL,
              url.scheme?.lowercased() == "https", ServerEnvironment.origin(of: url) == environment.origin,
              let token = token() else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let refusal = self.refusal
        let started = generation
        let task = Task<Data?, Never> {
            guard let result = try? await session.data(for: request, delegate: refusal),
                  (result.1 as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return result.0
        }
        inFlight[fileId] = task
        let data = await task.value
        inFlight[fileId] = nil
        guard generation == started, let data else { return data }
        cache[fileId] = data
        order.append(fileId)
        if order.count > Self.capacity { cache[order.removeFirst()] = nil }
        return data
    }

    func removeAll() {
        generation += 1
        inFlight.values.forEach { $0.cancel() }
        inFlight.removeAll()
        cache.removeAll()
        order.removeAll()
    }
}

/// Tests and previews: the message transport is not there.
struct UnavailableDeliveryBackend: DeliveryBackend {
    func sync(cursor: String?, limit: Int64) async -> SyncOutcome { .failed(status: 0, retryAfterMs: nil) }
    func history(_ conversation: String) async throws -> [JSONObject] { throw URLError(.notConnectedToInternet) }
    func unreadSnapshot() async throws -> UnreadSnapshot { throw URLError(.notConnectedToInternet) }
    func post(path: String, body: JSONObject) async -> HTTPOutcome { HTTPOutcome(status: 0, body: nil) }
}

struct UnavailableAttachmentUploader: AttachmentUploader {
    func upload(file: URL, name: String, mimeType: String, progress: @escaping @Sendable (Double) -> Void) async throws -> FileUploadResponse {
        throw URLError(.notConnectedToInternet)
    }
}

struct UnavailableDownloadTransport: DownloadTransport {
    func get(fileId: Int64, rangeFrom: Int64?, ifRange: String?, ifNoneMatch: String?) async throws -> DownloadResponse {
        throw URLError(.notConnectedToInternet)
    }
}
