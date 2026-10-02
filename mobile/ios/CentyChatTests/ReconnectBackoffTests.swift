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

        XCTAssertEqual(harness.sentFrames.first, .text(#"{"token":"secret-token","type":"auth"}"#).normalizedJSON)
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

    func makeClient() -> WebSocketClient {
        let script = self.script
        let sent = self.sent
        let clock = self.clock
        let created = self.created
        return WebSocketClient(
            credentials: { ("https://chat.example.com", "secret-token") },
            makeTransport: { _ in
                created.withValue { $0 += 1 }
                let step = script.withValue { steps -> TransportStep in
                    steps.isEmpty ? .failImmediately : steps.removeFirst()
                }
                return ScriptedTransport(step: step, sent: sent)
            },
            sleep: { seconds in try await clock.sleep(seconds) },
            jitter: { 0 },
            pingIntervalSeconds: ManualClock.heartbeatInterval
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
