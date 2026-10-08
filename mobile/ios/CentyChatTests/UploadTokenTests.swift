import Foundation
import XCTest
@testable import CentyChat

/// A request that got 401 is repeated only with its own session's renewed token — never with the
/// token of an account that signed in meanwhile.
final class UploadTokenTests: XCTestCase {
    private var keychain: KeychainManager!
    private var file: URL!

    override func setUpWithError() throws {
        keychain = KeychainManager(testStore: SeededKeychainItemStore())
        try keychain.saveAuthToken("token-A")
        file = FileManager.default.temporaryDirectory.appendingPathComponent("upload-token-\(UUID().uuidString).pdf")
        try Data("%PDF-1".utf8).write(to: file)
        ScriptedHTTP.reset()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: file)
        ScriptedHTTP.reset()
    }

    private func client() -> APIClient {
        APIClient(session: ScriptedHTTP.session(), keychain: keychain, environment: .test)
    }

    private static let uploaded = #"{"id":42,"originalName":"a.pdf","storedFilename":"x","fileSize":6,"mimeType":"application/pdf","url":"/api/files/download/42"}"#

    func testAFileOfTheOldSessionNeverGoesUpWithTheNextAccountsToken() async throws {
        let keychain = self.keychain!
        ScriptedHTTP.handler = { request, _ in
            if request.url?.path == "/api/files/upload" {
                // Another account signs in while this upload is answered 401.
                try? keychain.saveAuthToken("token-B")
                return (401, #"{"error":"Требуется вход"}"#)
            }
            return (500, "{}")
        }

        do {
            _ = try await client().uploadFile(at: file, fileName: "a.pdf", mimeType: "application/pdf") { _ in }
            XCTFail("the old session's upload must end, not go on under another account")
        } catch APIError.unauthorized {
        } catch {
            XCTFail("unexpected \(error)")
        }

        let uploads = ScriptedHTTP.requests.filter { $0.url?.path == "/api/files/upload" }
        XCTAssertEqual(uploads.count, 1)
        XCTAssertFalse(ScriptedHTTP.requests.contains { $0.value(forHTTPHeaderField: "Authorization") == "Bearer token-B" })
        XCTAssertEqual(keychain.authToken, "token-B", "the other account's session is left alone")
    }

    func testAnExpiredTokenIsRenewedAndTheUploadRepeatedWithIt() async throws {
        ScriptedHTTP.handler = { request, index in
            switch request.url?.path {
            case "/api/files/upload":
                return index == 0 ? (401, #"{"error":"Токен истёк"}"#) : (201, Self.uploaded)
            case "/api/auth/refresh":
                return (200, #"{"token":"token-A2"}"#)
            default:
                return (500, "{}")
            }
        }

        let response = try await client().uploadFile(at: file, fileName: "a.pdf", mimeType: "application/pdf") { _ in }

        XCTAssertEqual(response.id, 42)
        let uploads = ScriptedHTTP.requests.filter { $0.url?.path == "/api/files/upload" }
        XCTAssertEqual(uploads.map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer token-A", "Bearer token-A2"])
    }

    func testARequestThatGotItsAnswerAfterAPasswordChangeIsRepeatedWithTheNewToken() async throws {
        let fixtures = try XCTUnwrap(Bundle(for: UploadTokenTests.self).url(forResource: "fixtures", withExtension: nil))
        let me = try String(contentsOf: fixtures.appendingPathComponent("http/auth.me.json"), encoding: .utf8)
        let user = try XCTUnwrap(JSONValue.parse(me)?["user"])
        let changed = JSONValue.object(["success": true, "message": "Пароль изменён", "token": "token-T2", "user": user]).jsonText
        let entered = Locked(false)
        let release = DispatchSemaphore(value: 0)
        ScriptedHTTP.handler = { request, index in
            switch request.url?.path {
            case "/api/auth/me":
                if index == 0 {
                    // Sent with T1; its 401 is held back until the password change stored T2.
                    entered.withValue { $0 = true }
                    return (401, #"{"error":"Токен отозван"}"#)
                }
                return (200, me)
            case "/api/users/password":
                return (200, changed)
            default:
                return (500, "{}")
            }
        }
        ScriptedHTTP.hold("/api/auth/me", index: 0, until: release)
        let client = client()

        async let current = client.getCurrentUser()
        while !entered.value { try await Task.sleep(nanoseconds: 10_000_000) }
        _ = try await client.changePassword(request: ChangePasswordRequest(oldPassword: "старый", newPassword: "Новый-пароль-1"))
        release.signal()
        let user2 = try await current

        XCTAssertEqual(user2.id, 2, "the session survives: no unauthorized for a token this session itself replaced")
        XCTAssertEqual(keychain.authToken, "token-T2", "the valid new token is never wiped")
        let retried = ScriptedHTTP.requests.filter { $0.url?.path == "/api/auth/me" }.map { $0.value(forHTTPHeaderField: "Authorization") }
        XCTAssertEqual(retried, ["Bearer token-A", "Bearer token-T2"])
    }

    func testADeliveryPostOfTheOldSessionIsNotRepeatedUnderTheNextAccount() async throws {
        let keychain = self.keychain!
        ScriptedHTTP.handler = { request, _ in
            if request.url?.path == "/api/messages/direct/3" {
                try? keychain.saveAuthToken("token-B")
                return (401, #"{"error":"Требуется вход"}"#)
            }
            return (500, "{}")
        }

        let response = await client().raw(method: "POST", endpoint: "/messages/direct/3", body: Data("{}".utf8))

        XCTAssertEqual(response.status, 401)
        XCTAssertFalse(ScriptedHTTP.requests.contains { $0.value(forHTTPHeaderField: "Authorization") == "Bearer token-B" })
    }
}

/// Answers from a closure with the request and its index; records every request.
final class ScriptedHTTP: URLProtocol {
    typealias Handler = @Sendable (URLRequest, Int) -> (Int, String)

    private static let state = Locked<(requests: [URLRequest], handler: Handler?, holds: [String: DispatchSemaphore])>(([], nil, [:]))

    static var requests: [URLRequest] { state.value.requests }

    static var handler: Handler? {
        get { state.value.handler }
        set { state.withValue { $0.handler = newValue } }
    }

    static func reset() {
        state.withValue { $0 = ([], nil, [:]) }
    }

    /// The answer to the `index`-th request of `path` is delivered only after `release` is signalled
    /// (without blocking the URL-loading thread, so other requests go on meanwhile).
    static func hold(_ path: String, index: Int, until release: DispatchSemaphore) {
        state.withValue { $0.holds["\(path)#\(index)"] = release }
    }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ScriptedHTTP.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (index, handler, hold) = Self.state.withValue { state -> (Int, Handler?, DispatchSemaphore?) in
            let samePath = state.requests.filter { $0.url?.path == request.url?.path }.count
            state.requests.append(request)
            return (samePath, state.handler, state.holds["\(request.url?.path ?? "")#\(samePath)"])
        }
        guard let url = request.url, let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let (status, body) = handler(request, index)
        pending = (HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, Data(body.utf8))
        guard let hold else {
            deliverPending()
            return
        }
        // Answer later, on the loading thread, once the test releases it.
        let target = Delivery(proto: self, thread: Thread.current)
        DispatchQueue.global().async {
            hold.wait()
            target.proto.perform(#selector(ScriptedHTTP.deliverPending), on: target.thread, with: nil, waitUntilDone: false, modes: [RunLoop.Mode.default.rawValue])
        }
    }

    private var pending: (HTTPURLResponse, Data)?

    @objc private func deliverPending() {
        guard let (response, data) = pending else { return }
        pending = nil
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    private final class Delivery: @unchecked Sendable {
        let proto: ScriptedHTTP
        let thread: Thread

        init(proto: ScriptedHTTP, thread: Thread) {
            self.proto = proto
            self.thread = thread
        }
    }

    override func stopLoading() {}
}
