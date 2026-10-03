import Foundation
@testable import CentyChat

/// Records every request and answers from a scripted stub server.
/// Only requests to `ServerEnvironment.test` get an answer; anything else fails, so a
/// request to a stale or foreign host shows up both in `requests` and as an error.
final class RecordingURLProtocol: URLProtocol {
    struct RecordedRequest: Sendable {
        let url: URL?
        let method: String?
        let headers: [String: String]
        let body: Data?
    }

    struct StubResponse: Sendable {
        var status: Int
        var headers: [String: String] = [:]
        var body: String
    }

    private static let state = Locked<(requests: [RecordedRequest], routes: [String: StubResponse])>(([], [:]))

    static var requests: [RecordedRequest] { state.value.requests }

    static func reset(routes: [String: StubResponse] = defaultRoutes) {
        state.withValue { $0 = ([], routes) }
    }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    static let defaultRoutes: [String: StubResponse] = [
        "/api/health": StubResponse(status: 200, body: #"{"status":"ok"}"#),
        "/api/settings/info": StubResponse(status: 200, body: """
        {"server_name":"CentyChat Server","company_name":"ТОО «Тестовая компания»","allow_registration":false,\
        "message_edit_window_minutes":"60","message_delete_window_minutes":"60","version":"1.0.0"}
        """),
        "/api/auth/knock": StubResponse(status: 200, body: """
        {"status":"login_required","device_id":"device-1","device_name":"Test iPhone","message":"Нужен вход по паролю"}
        """),
    ]

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let recorded = RecordedRequest(
            url: request.url,
            method: request.httpMethod,
            headers: request.allHTTPHeaderFields ?? [:],
            body: request.httpBody ?? Self.readBody(request.httpBodyStream)
        )
        let route = Self.state.withValue { state -> StubResponse? in
            state.requests.append(recorded)
            guard request.url?.host == ServerEnvironment.test.serverURL.host else { return nil }
            return state.routes[request.url?.path ?? ""]
        }

        guard let url = request.url, let route,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: route.status,
                  httpVersion: "HTTP/1.1",
                  headerFields: route.headers.merging(["Content-Type": "application/json"]) { current, _ in current }
              ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(route.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
