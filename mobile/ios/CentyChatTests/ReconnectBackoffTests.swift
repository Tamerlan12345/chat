import Foundation
import XCTest
@testable import CentyChat

/// Reconnect policy of `WebSocketClient` (contract §6.3: 1 s, 2 s, 4 s … up to 30 s).
final class ReconnectBackoffTests: XCTestCase {
    func testReconnectDelaysGrowExponentiallyAcrossFailedAttempts() async throws {
        let harness = SocketHarness(script: Array(repeating: .failImmediately, count: 8))
        let client = harness.makeClient()

        await client.connect()
        let delays = try await harness.clock.waitForDelays(count: 6)
        await client.disconnect()

        XCTAssertEqual(delays, [1, 2, 4, 8, 16, 30])
    }

    func testBackoffStartsOverAfterASuccessfulConnection() async throws {
        let harness = SocketHarness(script: [
            .failImmediately,
            .failImmediately,
            .deliverThenFail(SocketFrames.authSuccess),
            .failImmediately,
        ])
        let client = harness.makeClient()

        await client.connect()
        let delays = try await harness.clock.waitForDelays(count: 4)
        await client.disconnect()

        XCTAssertEqual(delays, [1, 2, 1, 2])
    }

    func testFramesBeforeAuthSuccessDoNotResetTheBackoff() async throws {
        let harness = SocketHarness(script: [
            .failImmediately,
            .failImmediately,
            .deliverThenFail(#"{"type":"wake_state","retryAt":0}"#),
            .failImmediately,
        ])
        let client = harness.makeClient()

        await client.connect()
        let delays = try await harness.clock.waitForDelays(count: 4)
        await client.disconnect()

        XCTAssertEqual(delays, [1, 2, 4, 8])
    }

    func testAuthErrorClosesTheSocketWithoutResettingTheBackoff() async throws {
        // The server answers auth_error and keeps the socket open until its 10 s auth timeout.
        let harness = SocketHarness(script: [
            .failImmediately,
            .failImmediately,
            .deliverThenHang(SocketFrames.rateLimited),
            .failImmediately,
        ])
        let client = harness.makeClient()

        await client.connect()
        let delays = try await harness.clock.waitForDelays(count: 4)
        await client.disconnect()

        XCTAssertEqual(delays, [1, 2, 4, 8])
    }

    func testRepeatedAuthErrorIsReportedOnce() async throws {
        let harness = SocketHarness(script: Array(repeating: .deliverThenHang(SocketFrames.rateLimited), count: 4))
        let client = harness.makeClient()
        let events = await client.makeEventStream()
        let counter = Locked(0)
        let consumer = Task {
            for await event in events {
                if case .authError = event { counter.withValue { $0 += 1 } }
            }
        }

        await client.connect()
        _ = try await harness.clock.waitForDelays(count: 3)
        await client.disconnect()
        consumer.cancel()

        XCTAssertEqual(counter.value, 1, "A repeated auth_error must be reported once, not on every retry")
        XCTAssertGreaterThanOrEqual(harness.transportCount, 3)
    }

    /// While the device is locked before its first unlock the stored session cannot be read: the
    /// socket waits (with the usual backoff) instead of connecting without a token, which the
    /// server would answer with a rejection that ends the session.
    func testNoSocketOpensWhileTheStoredSessionCannotBeRead() async throws {
        let readable = Locked(false)
        let harness = SocketHarness(script: [.deliverThenHang(SocketFrames.authSuccess)])
        let client = harness.makeClient(tokenReadable: { readable.value })

        await client.connect()
        let delays = try await harness.clock.waitForDelays(count: 2)
        XCTAssertEqual(harness.transportCount, 0, "no socket without a readable token")
        XCTAssertEqual(delays, [1, 2])

        readable.withValue { $0 = true }
        for _ in 0..<200 where harness.transportCount == 0 {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        await client.disconnect()
        XCTAssertEqual(harness.transportCount, 1, "once readable, it connects")
    }

    /// Readable but absent (a refused refresh cleared it): no socket goes out without a token — the
    /// server would close it — and the session is asked to check itself, once per streak (review
    /// fix round 1). It still ends only on a definitive refusal (SessionStore).
    func testATokenlessSocketIsNeverOpenedAndTheSessionChecksItself() async throws {
        let harness = SocketHarness(script: [])
        let client = harness.makeClient(token: nil)
        let events = await client.makeEventStream()
        let codes = Locked<[String]>([])
        let consumer = Task {
            for await event in events {
                if case .authError(let code, _) = event { codes.withValue { $0.append(code) } }
            }
        }

        await client.connect()
        _ = try await harness.clock.waitForDelays(count: 3)
        for _ in 0..<200 where codes.value.isEmpty {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        await client.disconnect()
        consumer.cancel()

        XCTAssertEqual(harness.transportCount, 0)
        XCTAssertEqual(codes.value, ["TOKEN_MISSING"])
    }

    func testJitterNeverPushesTheDelayAboveTheCap() {
        var backoff = ReconnectBackoff()
        var delays: [TimeInterval] = []
        for _ in 0..<10 {
            delays.append(backoff.nextDelay(jitter: 0.2))
        }

        XCTAssertLessThanOrEqual(delays.max() ?? 0, ReconnectBackoff.maxSeconds)
        XCTAssertEqual(delays.first ?? 0, 1.2, accuracy: 0.0001)
    }

    func testConnectionStateReportsTheScheduledReconnect() async throws {
        let harness = SocketHarness(script: [.failImmediately], holdReconnects: true)
        let client = harness.makeClient()

        await client.connect()
        _ = try await harness.clock.waitForDelays(count: 1)
        let state = await client.connectionState
        await client.disconnect()
        let stateAfterDisconnect = await client.connectionState

        XCTAssertEqual(state, .reconnecting(attempt: 1, delay: 1))
        XCTAssertEqual(stateAfterDisconnect, .disconnected)
    }

    func testFirstFrameAfterConnectIsAuthentication() async throws {
        let harness = SocketHarness(script: [.failImmediately], holdReconnects: true)
        let client = harness.makeClient()

        await client.connect()
        _ = try await harness.clock.waitForDelays(count: 1)
        await client.disconnect()

        // ws-protocol.md §auth: mobile clients must send device_id, and say platform and presence.
        guard case .text(let text)? = harness.sentFrames.first,
              let frame = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
            return XCTFail("The first frame must be a JSON text frame")
        }
        XCTAssertEqual(frame["type"] as? String, "auth")
        XCTAssertEqual(frame["token"] as? String, "secret-token")
        XCTAssertEqual(frame["platform"] as? String, "ios")
        XCTAssertEqual(frame["presence"] as? String, "online")
        XCTAssertFalse((frame["device_id"] as? String ?? "").isEmpty)
    }
}

/// The socket as the delivery engine sees it: every frame in order, a close, writes only when authenticated.
final class DeliveryLinkSocketTests: XCTestCase {
    func testEveryFrameReachesTheDeliveryStreamInOrderAndTheCloseFollows() async throws {
        let harness = SocketHarness(script: [.deliverThenFail(SocketFrames.authSuccess)], holdReconnects: true)
        let client = harness.makeClient()
        let frames = await client.makeDeliveryFrameStream()
        let received = Locked<[DeliveryLinkFrame]>([])
        let consumer = Task {
            for await frame in frames {
                received.withValue { $0.append(frame) }
            }
        }

        await client.connect()
        _ = try await harness.clock.waitForDelays(count: 1)
        await client.disconnect()
        consumer.cancel()

        let got = received.value
        XCTAssertEqual(got.count, 2, "auth_success, then the close: \(got)")
        guard case .frame(let first)? = got.first else { return XCTFail("the first item must be the frame") }
        XCTAssertEqual(first["type"]?.string, "auth_success")
        XCTAssertEqual(first["user"]?["id"]?.int64, 1)
        XCTAssertEqual(got.last, .closed)
    }

    func testAFrameIsWrittenOnlyOnAnAuthenticatedSocket() async throws {
        let harness = SocketHarness(script: [.deliverThenHang(#"{"type":"wake_state","retryAt":0}"#), .deliverThenHang(SocketFrames.authSuccess)], holdReconnects: false)
        let client = harness.makeClient()
        let frame: JSONObject = ["type": "mark_read", "conversationType": "direct", "targetId": 3]

        await client.connect()
        try await Task.sleep(nanoseconds: 50_000_000)
        let beforeAuth = await client.sendFrame(frame)
        let userBeforeAuth = await client.authenticatedUserId
        XCTAssertFalse(beforeAuth, "no auth_success yet: the engine must hear the frame was not written")
        XCTAssertNil(userBeforeAuth)

        await client.restart()
        _ = try await harness.clock.waitForDelays(count: 1)
        var written = false
        for _ in 0..<100 where !written {
            written = await client.sendFrame(frame)
            if !written { try await Task.sleep(nanoseconds: 10_000_000) }
        }
        let user = await client.authenticatedUserId
        await client.disconnect()
        let userAfterClose = await client.authenticatedUserId

        XCTAssertTrue(written)
        XCTAssertEqual(user, 1)
        XCTAssertNil(userAfterClose)
        XCTAssertTrue(harness.sentFrames.contains(.text(#"{"conversationType":"direct","targetId":3,"type":"mark_read"}"#)))
    }
}

// MARK: - Harness

private enum TransportStep: Sendable {
    case failImmediately
    case deliverThenFail(String)
    /// Delivers one frame, then keeps the socket open until it is cancelled.
    case deliverThenHang(String)
}

private enum SocketFrames {
    static let authSuccess = #"{"type":"auth_success","user":{"id":1,"username":"qa","full_name":"QA User","is_active":1,"must_change_password":0}}"#
    static let rateLimited = #"{"type":"auth_error","code":"RATE_LIMITED","message":"Слишком много попыток. Повторите через минуту."}"#
}

private struct TransportClosed: Error {}

private final class ScriptedTransport: WebSocketTransport, @unchecked Sendable {
    private let pending: Locked<[WebSocketFrame]>
    private let sent: Locked<[WebSocketFrame]>
    private let hangsWhenDrained: Bool

    init(step: TransportStep, sent: Locked<[WebSocketFrame]>) {
        switch step {
        case .failImmediately:
            pending = Locked([])
            hangsWhenDrained = false
        case .deliverThenFail(let text):
            pending = Locked([.text(text)])
            hangsWhenDrained = false
        case .deliverThenHang(let text):
            pending = Locked([.text(text)])
            hangsWhenDrained = true
        }
        self.sent = sent
    }

    func resume() {}

    func send(_ frame: WebSocketFrame, completion: @escaping @Sendable (Error?) -> Void) {
        sent.withValue { $0.append(frame) }
        completion(nil)
    }

    func receive() async throws -> WebSocketFrame {
        let next = pending.withValue { frames -> WebSocketFrame? in
            frames.isEmpty ? nil : frames.removeFirst()
        }
        guard let next else {
            if hangsWhenDrained {
                // Like a server waiting for its auth timeout; ends when the client cancels the task.
                try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
            }
            throw TransportClosed()
        }
        return next
    }

    func sendPing(completion: @escaping @Sendable (Error?) -> Void) {
        completion(nil)
    }

    func cancel() {}
}

/// Records reconnect delays. The heartbeat uses a huge interval and simply waits.
private actor ManualClock {
    static let heartbeatInterval: TimeInterval = 3_600

    private(set) var delays: [TimeInterval] = []
    private let holdReconnects: Bool

    init(holdReconnects: Bool) {
        self.holdReconnects = holdReconnects
    }

    func sleep(_ seconds: TimeInterval) async throws {
        if seconds >= Self.heartbeatInterval || holdReconnects && !delays.isEmpty {
            try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
            return
        }
        delays.append((seconds * 1000).rounded() / 1000)
        if holdReconnects {
            try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
        }
    }

    func waitForDelays(count: Int, timeout: TimeInterval = 5) async throws -> [TimeInterval] {
        let deadline = Date().addingTimeInterval(timeout)
        while delays.count < count {
            guard Date() < deadline else {
                XCTFail("Only \(delays.count) of \(count) reconnects were scheduled: \(delays)")
                return delays
            }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        return Array(delays.prefix(count))
    }
}

private final class SocketHarness: @unchecked Sendable {
    let clock: ManualClock
    private let script: Locked<[TransportStep]>
    private let sent = Locked<[WebSocketFrame]>([])
    private let created = Locked(0)

    var transportCount: Int { created.value }

    init(script: [TransportStep], holdReconnects: Bool = false) {
        self.script = Locked(script)
        self.clock = ManualClock(holdReconnects: holdReconnects)
    }

    var sentFrames: [WebSocketFrame] {
        sent.value.map(\.normalizedJSON)
    }

    func makeClient(token: String? = "secret-token", tokenReadable: @escaping @Sendable () -> Bool = { true }) -> WebSocketClient {
        let script = self.script
        let sent = self.sent
        let clock = self.clock
        let created = self.created
        return WebSocketClient(
            credentials: { ("https://chat.example.com", token) },
            makeTransport: { _ in
                created.withValue { $0 += 1 }
                let step = script.withValue { steps -> TransportStep in
                    steps.isEmpty ? .failImmediately : steps.removeFirst()
                }
                return ScriptedTransport(step: step, sent: sent)
            },
            sleep: { seconds in try await clock.sleep(seconds) },
            jitter: { 0 },
            pingIntervalSeconds: ManualClock.heartbeatInterval,
            tokenReadable: tokenReadable
        )
    }
}

private extension WebSocketFrame {
    /// Re-serializes JSON text frames with sorted keys so they compare stably.
    var normalizedJSON: WebSocketFrame {
        guard case .text(let text) = self,
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let sorted = String(data: data, encoding: .utf8) else {
            return self
        }
        return .text(sorted)
    }
}
