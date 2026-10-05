import Foundation

/// Avatar photos loaded with the session token (skeleton).
actor AvatarImageLoader {
    private let serverURL: URL
    private let session: URLSession
    private let token: @Sendable () -> String?
    private let directory: URL?
    private let now: @Sendable () -> Date

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
    }

    static func inMemory(serverURL: URL) -> AvatarImageLoader {
        AvatarImageLoader(serverURL: serverURL, session: URLSession(configuration: .ephemeral), token: { nil }, directory: nil)
    }

    static func resolve(_ raw: String?, serverURL: URL, diameter: CGFloat) -> URL? {
        nil
    }

    func data(for url: URL) async -> Data? {
        nil
    }

    func cachedData(for url: URL) -> Data? {
        nil
    }

    func removeAll() {}
}
