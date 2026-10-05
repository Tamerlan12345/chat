import CryptoKit
import Foundation

/// Avatars as links (server task 20; `openapi.yaml` `User.avatar_url`, `ws-protocol.md`): every
/// request to the server carries `X-Avatar-Format: url` and the socket connects with
/// `?avatars=url`, so `avatar_url` / `sender_avatar` arrive as `/api/users/<id>/avatar?v=<version>`
/// instead of a data URL in every answer. Android: `AvatarOptIn`.
enum AvatarOptIn {
    static let header = "X-Avatar-Format"
    static let value = "url"
    static let webSocketQuery = URLQueryItem(name: "avatars", value: "url")

    /// `size=s` (96 px) for avatars up to 48 pt, `size=m` (256 px) above.
    enum Size: String, Sendable {
        case small = "s"
        case medium = "m"

        init(diameter: CGFloat) {
            self = diameter <= 48 ? .small : .medium
        }
    }
}

/// Loads avatar photos from the configured server's `/api/users/<id>/avatar` over HTTPS, with the
/// session's Bearer token. Nothing else is fetched: another host would learn the device's
/// address and another path must not get the token (initials instead).
///
/// Cache keyed by URL: memory (NSCache) and disk (Caches, excluded from backup). An entry is
/// fresh for the answer's `max-age`; after that it is revalidated with `If-None-Match` (304 keeps
/// it, 404 drops it, no network keeps showing it). The URL's `v=` changes when the photo does.
/// No URLCache is used, so `removeAll()` (sign-out, account deletion) really forgets every photo.
actor AvatarImageLoader {
    struct Metadata: Codable, Equatable, Sendable {
        var etag: String?
        var storedAt: Date
        var maxAge: TimeInterval

        func isFresh(at date: Date) -> Bool {
            date.timeIntervalSince(storedAt) < maxAge
        }
    }

    private final class MemoryEntry {
        let data: Data
        let metadata: Metadata

        init(data: Data, metadata: Metadata) {
            self.data = data
            self.metadata = metadata
        }
    }

    private struct Cached {
        let data: Data
        var metadata: Metadata
    }

    /// When the server sends no `max-age`.
    static let defaultMaxAge: TimeInterval = 3_600

    let serverURL: URL
    private let session: URLSession
    private let token: @Sendable () -> String?
    private let directory: URL?
    private let now: @Sendable () -> Date
    private let memory: NSCache<NSString, MemoryEntry>
    private var inFlight: [URL: Task<Data?, Never>] = [:]
    /// Bumped by `removeAll()`: an answer for an older generation is not stored.
    private var generation = 0

    init(
        serverURL: URL,
        session: URLSession,
        token: @escaping @Sendable () -> String?,
        directory: URL?,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.serverURL = serverURL
        self.session = session
        self.token = token
        self.directory = directory
        self.now = now
        let memory = NSCache<NSString, MemoryEntry>()
        memory.totalCostLimit = 8 * 1024 * 1024
        self.memory = memory
    }

    /// The app's loader: the build's server, the stored session token, `Caches/Avatars`.
    static func live(environment: ServerEnvironment = .current, keychain: KeychainManager = .shared) -> AvatarImageLoader {
        AvatarImageLoader(
            serverURL: environment.serverURL,
            session: makeSession(),
            token: { keychain.authToken },
            directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
                .appendingPathComponent("Avatars", isDirectory: true)
        )
    }

    /// Without a token or disk (tests and previews that never show a server photo).
    static func inMemory(serverURL: URL) -> AvatarImageLoader {
        AvatarImageLoader(serverURL: serverURL, session: makeSession(), token: { nil }, directory: nil)
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 60
        return URLSession(configuration: configuration)
    }

    // MARK: - Which URL

    /// The address to load for `avatar_url` shown `diameter` points wide, or nil for initials.
    nonisolated func url(for raw: String?, diameter: CGFloat) -> URL? {
        Self.resolve(raw, serverURL: serverURL, diameter: diameter)
    }

    /// Server-relative paths resolve against the server. Only the server's own avatar path over
    /// HTTPS is loaded, with `size` for the diameter; anything else is nil (initials).
    static func resolve(_ raw: String?, serverURL: URL, diameter: CGFloat) -> URL? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        let resolved: URL?
        if value.hasPrefix("/") {
            guard !value.hasPrefix("//") else { return nil }
            resolved = URL(string: value, relativeTo: serverURL)?.absoluteURL
        } else {
            resolved = URL(string: value)
        }
        guard let url = resolved, isLoadable(url, serverURL: serverURL),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        var items = (components.queryItems ?? []).filter { $0.name != "size" }
        items.append(URLQueryItem(name: "size", value: AvatarOptIn.Size(diameter: diameter).rawValue))
        components.queryItems = items
        return components.url
    }

    /// HTTPS, the configured origin, the avatar path.
    private static func isLoadable(_ url: URL, serverURL: URL) -> Bool {
        url.scheme?.lowercased() == "https" && isOwnServer(url, serverURL: serverURL) && isAvatarPath(url.path)
    }

    private static func isOwnServer(_ url: URL, serverURL: URL) -> Bool {
        guard let origin = ServerEnvironment.origin(of: url) else { return false }
        return origin == ServerEnvironment.origin(of: serverURL)
    }

    /// `/api/users/<digits>/avatar`.
    private static func isAvatarPath(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 5, parts[0].isEmpty, parts[1] == "api", parts[2] == "users", parts[4] == "avatar" else {
            return false
        }
        return !parts[3].isEmpty && parts[3].allSatisfy { $0.isASCII && $0.isNumber }
    }

    // MARK: - Loading

    /// The photo's bytes, from the cache when fresh, otherwise from the network.
    func data(for url: URL) async -> Data? {
        guard Self.isLoadable(url, serverURL: serverURL) else { return nil }
        let date = now()
        let cached = cachedEntry(for: url)
        if let cached, cached.metadata.isFresh(at: date) {
            return cached.data
        }
        if let running = inFlight[url] {
            return await running.value
        }
        let generation = self.generation
        let task = Task { await self.fetch(url, cached: cached, generation: generation) }
        inFlight[url] = task
        let result = await task.value
        if inFlight[url] == task {
            inFlight[url] = nil
        }
        return result
    }

    /// What the cache holds for `url` (memory, then disk), fresh or not. No network.
    func cachedData(for url: URL) -> Data? {
        cachedEntry(for: url)?.data
    }

    /// Forgets every photo: memory, disk and answers still on the way.
    func removeAll() {
        generation += 1
        for task in inFlight.values {
            task.cancel()
        }
        inFlight.removeAll()
        memory.removeAllObjects()
        if let directory, FileManager.default.fileExists(atPath: directory.path) {
            do {
                try FileManager.default.removeItem(at: directory)
            } catch {
                Log.network.error("Avatar cache wipe failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func fetch(_ url: URL, cached: Cached?, generation: Int) async -> Data? {
        var request = URLRequest(url: url)
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        // Only reached for the configured server's avatar path over HTTPS (`isLoadable`).
        guard ServerEndpointPolicy.allowsAuthorization(to: url), let token = token() else {
            return cached?.data
        }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let etag = cached?.metadata.etag {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }

        let body: Data
        let response: HTTPURLResponse
        do {
            let (data, urlResponse) = try await session.data(for: request, delegate: RefuseRedirects.shared)
            guard let http = urlResponse as? HTTPURLResponse else {
                return generation == self.generation ? cached?.data : nil
            }
            (body, response) = (data, http)
        } catch {
            // Offline: keep showing what we have.
            return generation == self.generation ? cached?.data : nil
        }
        guard generation == self.generation else { return nil }

        switch response.statusCode {
        case 200...299:
            guard !body.isEmpty, response.mimeType?.lowercased().hasPrefix("image/") == true else { return nil }
            let metadata = Metadata(
                etag: response.value(forHTTPHeaderField: "ETag"),
                storedAt: now(),
                maxAge: Self.maxAge(from: response.value(forHTTPHeaderField: "Cache-Control"))
            )
            store(Cached(data: body, metadata: metadata), for: url)
            return body
        case 304:
            guard var renewed = cached else { return nil }
            renewed.metadata.storedAt = now()
            if let maxAge = response.value(forHTTPHeaderField: "Cache-Control").map(Self.maxAge(from:)) {
                renewed.metadata.maxAge = maxAge
            }
            store(renewed, for: url)
            return renewed.data
        case 404, 410:
            remove(url)
            return nil
        default:
            return cached?.data
        }
    }

    /// `max-age` from `Cache-Control`; `no-cache` / `no-store` mean «revalidate every time».
    static func maxAge(from cacheControl: String?) -> TimeInterval {
        guard let cacheControl else { return defaultMaxAge }
        for directive in cacheControl.split(separator: ",") {
            let parts = directive.trimmingCharacters(in: .whitespaces).split(separator: "=", maxSplits: 1)
            let name = parts.first?.lowercased() ?? ""
            if name == "no-cache" || name == "no-store" {
                return 0
            }
            if name == "max-age", parts.count == 2, let seconds = TimeInterval(parts[1].trimmingCharacters(in: .whitespaces)) {
                return max(0, seconds)
            }
        }
        return defaultMaxAge
    }

    // MARK: - Cache

    private func cachedEntry(for url: URL) -> Cached? {
        let key = url.absoluteString as NSString
        if let entry = memory.object(forKey: key) {
            return Cached(data: entry.data, metadata: entry.metadata)
        }
        guard let disk = readDisk(url) else { return nil }
        memory.setObject(MemoryEntry(data: disk.data, metadata: disk.metadata), forKey: key, cost: disk.data.count)
        return disk
    }

    private func store(_ entry: Cached, for url: URL) {
        memory.setObject(
            MemoryEntry(data: entry.data, metadata: entry.metadata),
            forKey: url.absoluteString as NSString,
            cost: entry.data.count
        )
        writeDisk(entry, for: url)
    }

    private func remove(_ url: URL) {
        memory.removeObject(forKey: url.absoluteString as NSString)
        guard let files = files(for: url) else { return }
        try? FileManager.default.removeItem(at: files.data)
        try? FileManager.default.removeItem(at: files.metadata)
    }

    /// `<sha256 of the URL>.img` and `.meta` in the cache directory.
    private func files(for url: URL) -> (data: URL, metadata: URL)? {
        guard let directory else { return nil }
        let name = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return (
            directory.appendingPathComponent(name + ".img", isDirectory: false),
            directory.appendingPathComponent(name + ".meta", isDirectory: false)
        )
    }

    private func readDisk(_ url: URL) -> Cached? {
        guard let files = files(for: url),
              let data = try? Data(contentsOf: files.data),
              let encoded = try? Data(contentsOf: files.metadata),
              let metadata = try? JSONDecoder().decode(Metadata.self, from: encoded) else {
            return nil
        }
        return Cached(data: data, metadata: metadata)
    }

    private func writeDisk(_ entry: Cached, for url: URL) {
        guard let files = files(for: url), prepareDirectory() else { return }
        do {
            try entry.data.write(to: files.data, options: .atomic)
            try JSONEncoder().encode(entry.metadata).write(to: files.metadata, options: .atomic)
        } catch {
            Log.network.error("Avatar cache write failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Creates the directory on first use and keeps it out of backups.
    private func prepareDirectory() -> Bool {
        guard var directory else { return false }
        if FileManager.default.fileExists(atPath: directory.path) { return true }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
            return true
        } catch {
            Log.network.error("Avatar cache directory unavailable: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }
}

/// Avatars are never redirected: a redirect would carry the Bearer token to another host.
private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    static let shared = RefuseRedirects()

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}
