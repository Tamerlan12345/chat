import Foundation
@testable import CentyChat

/// A clock the test moves: `sleep` returns once `advance` passes its wake time.
final class ManualDeliveryClock: DeliveryClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Int64
    private var sleepers: [(wake: Int64, continuation: CheckedContinuation<Void, Never>)] = []

    init(now: Int64 = 1_000_000) {
        current = now
    }

    func now() -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func sleep(milliseconds: Int64) async throws {
        guard milliseconds > 0 else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            sleepers.append((current + milliseconds, continuation))
            lock.unlock()
        }
        try Task.checkCancellation()
    }

    /// Moves time on and wakes every sleeper that is due.
    func advance(by milliseconds: Int64) {
        lock.lock()
        current += milliseconds
        let now = current
        let due = sleepers.filter { $0.wake <= now }
        sleepers.removeAll { $0.wake <= now }
        lock.unlock()
        due.forEach { $0.continuation.resume() }
    }

    var pendingSleepers: Int {
        lock.lock()
        defer { lock.unlock() }
        return sleepers.count
    }
}

/// The socket as the engine sees it; records written frames.
final class FakeDeliveryLink: DeliveryLink, @unchecked Sendable {
    private struct State {
        var frames: [JSONObject] = []
        var accepting = true
        var authenticated: Int64?
        var restarts = 0
    }

    private let box = Locked(State())

    func send(_ frame: JSONObject) async -> Bool {
        box.withValue { state in
            guard state.accepting else { return false }
            state.frames.append(frame)
            return true
        }
    }

    func restart() async {
        box.withValue { $0.restarts += 1 }
    }

    func authenticatedUserId() async -> Int64? {
        box.value.authenticated
    }

    func setAccepting(_ value: Bool) {
        box.withValue { $0.accepting = value }
    }

    func setAuthenticated(_ user: Int64?) {
        box.withValue { $0.authenticated = user }
    }

    var sent: [JSONObject] { box.value.frames }

    var restartCount: Int { box.value.restarts }

    func clear() {
        box.withValue { $0.frames.removeAll() }
    }

    /// `send_message` frames for `clientMsgId`.
    func sends(of clientMsgId: String) -> Int {
        sent.filter { $0["type"]?.string == "send_message" && $0["client_msg_id"]?.string == clientMsgId }.count
    }

    func types() -> [String] {
        sent.compactMap { $0["type"]?.string }
    }
}

/// `/api/sync`, history, lists and `POST /messages` with scripted answers; records requests.
final class FakeDeliveryBackend: DeliveryBackend, @unchecked Sendable {
    private struct State {
        var syncAnswers: [SyncOutcome] = []
        var posts: [(path: String, body: JSONObject)] = []
        var postAnswer: @Sendable (JSONObject) -> HTTPOutcome = { _ in HTTPOutcome(status: 0, body: nil) }
        var postGate: TestGate?
        var histories: [String: [JSONObject]] = [:]
        var syncRequests: [String?] = []
        var snapshot = UnreadSnapshot(counts: [:], lastMessageIds: [:])
    }

    private let box = Locked(State())

    var snapshot: UnreadSnapshot {
        get { box.value.snapshot }
        set { box.withValue { $0.snapshot = newValue } }
    }

    /// The answers of the next `sync` calls; afterwards an empty last page.
    func queueSync(_ outcomes: SyncOutcome...) {
        box.withValue { $0.syncAnswers.append(contentsOf: outcomes) }
    }

    func answerPosts(_ answer: @escaping @Sendable (JSONObject) -> HTTPOutcome) {
        box.withValue { $0.postAnswer = answer }
    }

    /// Posts wait for the gate before they answer.
    func holdPosts(_ gate: TestGate) {
        box.withValue { $0.postGate = gate }
    }

    func setHistory(_ conversation: String, _ records: [JSONObject]) {
        box.withValue { $0.histories[conversation] = records }
    }

    var postedBodies: [JSONObject] { box.value.posts.map(\.body) }

    var syncCursors: [String?] { box.value.syncRequests }

    func sync(cursor: String?, limit: Int64) async -> SyncOutcome {
        let answer: SyncOutcome? = box.withValue { state in
            state.syncRequests.append(cursor)
            return state.syncAnswers.isEmpty ? nil : state.syncAnswers.removeFirst()
        }
        return answer ?? .page(["messages": [], "next_cursor": .string("c-\(cursor ?? "0")"), "has_more": false])
    }

    func history(_ conversation: String) async throws -> [JSONObject] {
        box.value.histories[conversation] ?? []
    }

    func unreadSnapshot() async throws -> UnreadSnapshot {
        box.value.snapshot
    }

    func post(path: String, body: JSONObject) async -> HTTPOutcome {
        let (gate, answer) = box.withValue { state in
            state.posts.append((path, body))
            return (state.postGate, state.postAnswer)
        }
        if let gate { await gate.wait() }
        return answer(body)
    }
}

/// Server records and frames as the server writes them.
enum DeliveryFixtures {
    static func record(
        id: Int64,
        from sender: Int64,
        to target: Int64,
        text: String = "Привет",
        type: String = "direct",
        clientMsgId: String? = nil,
        deleted: Bool = false
    ) -> JSONObject {
        [
            "id": .int(id),
            "conversation_type": .string(type),
            "target_id": .int(target),
            "sender_id": .int(sender),
            "text": .string(deleted ? "" : text),
            "type": "text",
            "reply_to_id": .null,
            "metadata_json": .null,
            "created_at": "2026-10-05T09:00:00.000Z",
            "updated_at": .null,
            "is_deleted": .int(deleted ? 1 : 0),
            "client_msg_id": .orNull(clientMsgId),
            "sender_name": "Отправитель",
        ]
    }

    static func authSuccess(_ user: Int64) -> DeliveryLinkFrame {
        .frame(["type": "auth_success", "user": ["id": .int(user), "username": .string("user\(user)")]])
    }

    static func echo(_ record: JSONObject) -> DeliveryLinkFrame {
        .frame(["type": "direct_message", "message": .object(record)])
    }
}
