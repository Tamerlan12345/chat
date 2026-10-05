import Foundation

/// Scripted answers for image requests: each URL gets a queue of replies, consumed in order.
/// A request with nothing queued fails as if offline. Every request is recorded with its headers.
final class AvatarStubURLProtocol: URLProtocol {
    struct Reply: Sendable {
        var status: Int
        var headers: [String: String] = [:]
        var body = Data()
        /// Answer with a redirect to this URL (the session asks its delegate whether to follow).
        var redirectTo: URL?
    }

    private static let state = Locked<(requests: [URLRequest], replies: [String: [Reply]])>(([], [:]))

    static var requests: [URLRequest] { state.value.requests }

    static func reset() {
        state.withValue { $0 = ([], [:]) }
    }

    static func enqueue(_ url: URL, _ reply: Reply) {
        state.withValue { $0.replies[url.absoluteString, default: []].append(reply) }
    }

    /// No URLCache: the loader's own cache is the only one under test.
    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AvatarStubURLProtocol.self]
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        let reply = Self.state.withValue { state -> Reply? in
            state.requests.append(request)
            let key = request.url?.absoluteString ?? ""
            guard var queue = state.replies[key], !queue.isEmpty else { return nil }
            let next = queue.removeFirst()
            state.replies[key] = queue
            return next
        }
        guard let url = request.url, let reply,
              let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers) else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        if let target = reply.redirectTo {
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target), redirectResponse: response)
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !reply.body.isEmpty {
            client?.urlProtocol(self, didLoad: reply.body)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
