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
            .deliverThenFail(#"{"type":"wake_state","retryAt":0}"#),
            .failImmediately,
        ])
        let client = harness.makeClient()

        await client.connect()
        let delays = try await harness.clock.waitForDelays(count: 4)
        await client.disconnect()

        XCTAssertEqual(delays, [1, 2, 1, 2])
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
}

private struct TransportClosed: Error {}

private final class ScriptedTransport: WebSocketTransport, @unchecked Sendable {
    private let pending: Locked<[WebSocketFrame]>
    private let sent: Locked<[WebSocketFrame]>

    init(step: TransportStep, sent: Locked<[WebSocketFrame]>) {
        switch step {
        case .failImmediately: pending = Locked([])
        case .deliverThenFail(let text): pending = Locked([.text(text)])
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
        guard let next else { throw TransportClosed() }
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
        return WebSocketClient(
            credentials: { ("https://chat.example.com", "secret-token") },
            makeTransport: { _ in
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
