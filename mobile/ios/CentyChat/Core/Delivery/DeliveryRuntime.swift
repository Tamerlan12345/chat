import Foundation
import Observation

/// Ties the delivery engine and the file queue to the session and the device: whose queue it is,
/// when it goes out without a socket, and what an explicit sign-out does with it.
///
/// The queue belongs to an account. A session that ends by itself (a revoked token, a refresh the
/// server refused) keeps it — it goes out once the same account is back. It is deleted only by an
/// explicit sign-out (after the user agreed), account deletion, or when another account signs in.
///
/// Without a BGTask the flush runs when the app comes to the foreground and when the network comes
/// back; with a socket the engine's own pump sends. Both go through the engine's one serial queue.
@MainActor
@Observable
final class DeliveryRuntime {
    enum FlushResult: Equatable {
        /// Nothing (sendable) is left, or the socket took over.
        case done
        /// Not this run: no signed-in account.
        case nothingToDo
        /// Something waits (no network, store unreadable): try again later.
        case retryLater
    }

    let engine: DeliveryEngine
    let uploads: AttachmentUploads

    @ObservationIgnored private let currentUser: @MainActor () -> Int64?
    @ObservationIgnored private let reconnect: @MainActor () async -> Void
    @ObservationIgnored private let clock: any DeliveryClock
    @ObservationIgnored private let readyTimeoutMs: Int64
    @ObservationIgnored private let log: @Sendable (String) -> Void
    @ObservationIgnored private var flushing = false

    static let maxRounds = 20
    private static let roundSlackMs: Int64 = 5_000

    init(
        engine: DeliveryEngine,
        uploads: AttachmentUploads,
        currentUser: @escaping @MainActor () -> Int64?,
        reconnect: @escaping @MainActor () async -> Void,
        clock: any DeliveryClock = SystemDeliveryClock(),
        readyTimeoutMs: Int64 = 60_000,
        log: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.engine = engine
        self.uploads = uploads
        self.currentUser = currentUser
        self.reconnect = reconnect
        self.clock = clock
        self.readyTimeoutMs = readyTimeoutMs
        self.log = log
    }

    /// Messages and files of the signed-in account that have not left the device (cancelled ones
    /// excluded). Another account's leftovers are never counted. Nil — unknown: the store cannot be
    /// read yet.
    var unsentCount: Int? {
        guard engine.ready else { return nil }
        guard let user = currentUser() else { return 0 }
        let state = engine.state
        let messages = state.me == user ? state.outbox.filter { !$0.pendingDelete }.count : 0
        return messages + uploads.waitingCount(of: user)
    }

    /// The queue is `user`'s (another account's is wiped first). False when that failed — logged.
    @discardableResult
    func adopt(_ user: Int64) async -> Bool {
        do {
            try await engine.adopt(user)
            return true
        } catch {
            log("the delivery queue could not be handed to account \(user): \(error)")
            return false
        }
    }

    /// Explicit sign-out or account deletion: the unsent messages and files are deleted. Throws when
    /// that could not be done — the caller must not sign out as if it had been.
    func discardForSignOut() async throws {
        // All or nothing for the user: the waiting files' rows first — if they cannot be deleted,
        // nothing is; then the messages (disk first, then memory). If those cannot be deleted the
        // files' rows are written back, and the account keeps its whole queue.
        try await uploads.clearStoredRows()
        do {
            try await engine.reset()
        } catch {
            await uploads.restoreStoredRows()
            throw error
        }
    }

    /// The device has a network again: a reconnect waiting for its backoff goes now, and what waits
    /// goes over HTTP until the socket is up.
    func networkBecameAvailable() async {
        await reconnect()
        _ = await flushInBackground()
    }

    /// The app came to the foreground.
    func appBecameActive() async {
        _ = await flushInBackground()
    }

    /// One flush without a socket: files go up and enter the outbox, then the heads of the outbox go
    /// over HTTP (`background_flush`, §6.2), round after round while it moves.
    func flushInBackground() async -> FlushResult {
        guard !flushing else { return .done }
        flushing = true
        defer { flushing = false }
        // A store that cannot be read is retried by the engine; this run gives up after a while.
        guard await waitUntilReady() else { return .retryLater }
        guard let user = currentUser() else { return .nothingToDo }
        // Only this account's queue goes out under this account's token.
        guard await adopt(user) else { return .retryLater }
        if engine.state.connection == DeliveryState.online { return .done }
        await uploads.flush()
        for _ in 0..<Self.maxRounds {
            let state = engine.state
            // The socket is up: its pump sends, and two senders never share an entry.
            if state.connection == DeliveryState.online { return .done }
            if !Self.hasSendable(state) { break }
            let outcome = await engine.backgroundFlush()
            guard outcome.effects.contains(where: { if case .sendHttp = $0 { return true } else { return false } }) else { break }
            // Wait for this round's answers (or their HTTP ack timeouts) before the next heads go.
            _ = await engine.wait(timeoutMs: DeliveryReducer.httpAckTimeoutMs + Self.roundSlackMs) { state in
                !state.outbox.contains { $0.state == OutboxEntry.sending && $0.transport == OutboxEntry.http }
            }
        }
        let left = engine.state
        let waiting = Self.hasSendable(left) || uploads.items.contains { !$0.pending.failed }
        return left.connection != DeliveryState.online && waiting ? .retryLater : .done
    }

    private func waitUntilReady() async -> Bool {
        var waited: Int64 = 0
        while !engine.ready {
            guard waited < readyTimeoutMs else { return false }
            try? await clock.sleep(milliseconds: 200)
            waited += 200
        }
        return true
    }

    /// Entries that still go out on their own (not refused, not cancelled).
    static func hasSendable(_ state: DeliveryState) -> Bool {
        state.outbox.contains { $0.state != OutboxEntry.failed && !$0.pendingDelete }
    }
}

/// «N неотправленных сообщений будут удалены» with Russian plural forms; nil when nothing waits.
enum UnsentNotice {
    static func text(_ count: Int?) -> String? {
        guard let count else {
            return String(localized: "Не удалось проверить неотправленные сообщения — если они есть, они будут удалены")
        }
        guard count > 0 else { return nil }
        let lastTwo = count % 100
        let last = count % 10
        if last == 1 && lastTwo != 11 {
            return String(localized: "\(count) неотправленное сообщение будет удалено")
        }
        if (2...4).contains(last) && !(12...14).contains(lastTwo) {
            return String(localized: "\(count) неотправленных сообщения будут удалены")
        }
        return String(localized: "\(count) неотправленных сообщений будут удалены")
    }
}
