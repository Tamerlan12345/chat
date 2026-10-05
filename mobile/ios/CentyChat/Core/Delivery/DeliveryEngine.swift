import Foundation
import Observation

/// Runs the delivery model (`delivery-state.md`) for the whole app: one serial queue of events
/// through `DeliveryReducer`, and the effects executed strictly in order (§5) — the `persist`
/// barrier first (nothing else of the step runs, and the new state is not taken, until the slices are
/// on disk), then socket frames, HTTP requests, alarms, sync chains and history loads, whose results
/// come back as events through the same queue.
///
/// Every sender — the socket pump and the HTTP flush without a socket — goes through this one queue,
/// so an outbox entry is never sent twice at once: the reducer moves it to `sending` in the same step
/// that emits the send, and every later step sees that.
///
/// The model belongs to one account (`me`). Another account's queue is wiped before anything of the
/// new one is taken (`adopt`, an `auth_success` of another user, an `enqueue` stamped with its
/// owner); nothing of one account is ever sent, synced or shown under another.
@MainActor
@Observable
public final class DeliveryEngine {
    /// What one event did: its effects, and whether its state reached the disk (§5 persist).
    public struct Outcome: Sendable, Equatable {
        public let persisted: Bool
        public let effects: [DeliveryEffect]

        public init(persisted: Bool, effects: [DeliveryEffect]) {
            self.persisted = persisted
            self.effects = effects
        }

        static let refused = Outcome(persisted: false, effects: [])

        /// `enqueue` was taken: the entry is on disk and the composer may clear (§7.4).
        public var composerCleared: Bool {
            persisted && effects.contains { if case .clearComposer = $0 { return true } else { return false } }
        }

        public var userError: String? {
            for effect in effects {
                if case .userError(let code) = effect { return code }
            }
            return nil
        }
    }

    /// A `user_error` (§5) to show; `serial` tells two equal codes apart.
    public struct UserError: Sendable, Equatable {
        public let code: String
        public let serial: Int
    }

    public enum EngineError: Error, Equatable {
        /// The store cannot be read or emptied right now (it is retried).
        case storeUnavailable(String)
        /// Loaded or typed for an account that is not the signed-in one (a late answer after a switch).
        case notTheSignedInAccount
    }

    /// The model after the last processed event. Changed only by the engine.
    public private(set) var state = DeliveryState()
    /// The stored model is loaded and `app_restart` applied.
    public private(set) var ready = false
    /// The last `user_error` effect.
    public private(set) var lastUserError: UserError?

    @ObservationIgnored private let store: any DeliveryStore
    @ObservationIgnored private let link: any DeliveryLink
    @ObservationIgnored private let backend: any DeliveryBackend
    @ObservationIgnored private let clock: any DeliveryClock
    @ObservationIgnored private let cacheDelayMs: Int64
    @ObservationIgnored private let log: @Sendable (String) -> Void

    /// Called after the model and its storage were wiped (sign-out, or another account).
    @ObservationIgnored public var onWipe: [@MainActor () -> Void] = []
    /// Called after every change of the model.
    @ObservationIgnored public var onStateChange: [@MainActor (DeliveryState) -> Void] = []
    /// Called with every `user_error` code (§5).
    @ObservationIgnored public var onUserError: [@MainActor (String) -> Void] = []

    // MARK: - The queue

    private enum Command {
        case dispatch(JSONObject, owner: Int64?, CheckedContinuation<Outcome, Never>?)
        case replaceHistory(String, [JSONObject], Set<Int64>, owner: Int64?, CheckedContinuation<Outcome, any Error>)
        case reset(CheckedContinuation<Void, any Error>)
        case adopt(Int64, CheckedContinuation<Void, any Error>)
        case restore
        case retryWipe
        case flushCache
        /// `conversation_closed`, only if `conversation` is still the visible one when it is processed.
        case closeIfVisible(String)
    }

    @ObservationIgnored private var queue: [Command] = []
    @ObservationIgnored private var draining = false
    @ObservationIgnored private var idleWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var started = false

    /// Requests and alarms of the current account; cancelled together when it is wiped.
    @ObservationIgnored private var work: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private var lastNow: Int64 = 0
    @ObservationIgnored private var alarms = Set<String>()
    @ObservationIgnored private var dirtyCache = Set<String>()
    @ObservationIgnored private var cacheFlushScheduled = false
    @ObservationIgnored private var errorSerial = 0
    @ObservationIgnored private var diskFailures: Int64 = 0
    @ObservationIgnored private var stateWaiters: [UUID: (predicate: (DeliveryState) -> Bool, continuation: CheckedContinuation<Bool, Never>)] = [:]

    /// Fail closed: the stored model could not be read ("load") or another account's could not be
    /// deleted ("wipe"). Until that is repaired (retried with backoff) nothing is accepted, persisted
    /// or sent — a persist now would overwrite the outbox on disk, a send could be the wrong account's.
    @ObservationIgnored private(set) var blocked: String?
    @ObservationIgnored private var repairAttempts: Int64 = 0

    /// The account the app is signed in as (the last `adopt`); nil after an explicit sign-out. A load or
    /// wipe that succeeds later applies it, and an enqueue is stamped with it.
    @ObservationIgnored private var signedIn: Int64?

    /// An explicit sign-out emptied the model; until an account is adopted nothing is taken: frames of
    /// the old socket are dropped (a later sync re-reads them), actions and pages refused, and an
    /// `auth_success` claims nothing. Unlike a cold launch, where `signedIn` is nil too.
    @ObservationIgnored private var signedOut = false
    @ObservationIgnored private var readyWaiters: [CheckedContinuation<Void, Never>] = []

    public init(
        store: any DeliveryStore,
        link: any DeliveryLink,
        backend: any DeliveryBackend,
        clock: any DeliveryClock = SystemDeliveryClock(),
        cacheDelayMs: Int64 = 1_000,
        log: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.store = store
        self.link = link
        self.backend = backend
        self.clock = clock
        self.cacheDelayMs = cacheDelayMs
        self.log = log
    }

    /// Loads the stored model. Frames and actions that arrive meanwhile wait in order behind it.
    public func start() {
        guard !started else { return }
        started = true
        submit(.restore)
    }

    private func submit(_ command: Command) {
        queue.append(command)
        guard !draining else { return }
        draining = true
        Task { await self.drain() }
    }

    private func drain() async {
        while !queue.isEmpty {
            let command = queue.removeFirst()
            await run(command)
        }
        draining = false
        let waiters = idleWaiters
        idleWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    /// Returns once the stored model is loaded (at once when it is).
    public func waitUntilReady() async {
        guard !ready else { return }
        await withCheckedContinuation { readyWaiters.append($0) }
    }

    private func markReady() {
        ready = true
        let waiters = readyWaiters
        readyWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    /// Returns once every command queued so far has been processed (tests and the background flush).
    public func idle() async {
        guard draining || !queue.isEmpty else { return }
        await withCheckedContinuation { idleWaiters.append($0) }
    }

    // MARK: - Entry points

    /// Processes `event` (its `now` is added) after everything queued before it; returns what it did.
    @discardableResult
    public func dispatch(_ event: JSONObject) async -> Outcome {
        await withCheckedContinuation { continuation in
            submit(.dispatch(event, owner: nil, continuation))
        }
    }

    /// Fire and forget.
    public func post(_ event: JSONObject) {
        submit(.dispatch(event, owner: nil, nil))
    }

    /// A socket frame (or its close) in arrival order.
    public func receive(_ frame: DeliveryLinkFrame) {
        switch frame {
        case .frame(let object): post(["type": "ws", "frame": .object(object)])
        case .closed: post(["type": "ws_disconnected"])
        }
    }

    /// `enqueue` (§6.3) for `owner`. `Outcome.composerCleared` — the message is on disk.
    public func enqueue(
        conversation: String,
        text: String,
        msgType: String = "text",
        replyToId: Int64? = nil,
        metadata: JSONValue? = nil,
        clientMsgId: String = DeliveryEngine.newClientMsgId(),
        owner: Int64
    ) async -> Outcome {
        let event: JSONObject = [
            "type": "enqueue",
            "client_msg_id": .string(clientMsgId),
            "conversation": .string(conversation),
            "text": .string(text),
            "msgType": .string(msgType),
            "reply_to_id": .orNull(replyToId),
            "metadata": metadata ?? .null,
        ]
        return await withCheckedContinuation { continuation in
            submit(.dispatch(event, owner: owner, continuation))
        }
    }

    /// A confirmed message's new text (`edit` by `message_id`).
    public func edit(messageId: Int64, text: String) async -> Outcome {
        await dispatch(["type": "edit", "message_id": .int(messageId), "text": .string(text)])
    }

    /// An unsent message's new text (`edit` by `client_msg_id`).
    public func edit(clientMsgId: String, text: String) async -> Outcome {
        await dispatch(["type": "edit", "client_msg_id": .string(clientMsgId), "text": .string(text)])
    }

    public func delete(messageId: Int64) async -> Outcome {
        await dispatch(["type": "delete", "message_id": .int(messageId)])
    }

    /// An unsent message is withdrawn: it is never sent later (§7.10).
    public func cancel(clientMsgId: String) async -> Outcome {
        await dispatch(["type": "cancel", "client_msg_id": .string(clientMsgId)])
    }

    public func retry(clientMsgId: String) async -> Outcome {
        await dispatch(["type": "retry", "client_msg_id": .string(clientMsgId), "new_client_msg_id": .string(Self.newClientMsgId())])
    }

    public func conversationOpened(_ conversation: String) {
        post(["type": "conversation_opened", "conversation": .string(conversation)])
    }

    public func conversationClosed() {
        post(["type": "conversation_closed"])
    }

    /// The screen of `conversation` closed. Checked when processed, after an open still in the
    /// queue: another chat opened meanwhile stays visible.
    public func conversationClosed(_ conversation: String) {
        submit(.closeIfVisible(conversation))
    }

    /// An older page of a conversation (`beforeId`), or any other page the screen loaded, for `owner`
    /// (the model is claimed for the account that loaded it).
    @discardableResult
    public func historyPage(_ records: [JSONObject], owner: Int64? = nil) async -> Outcome {
        await withCheckedContinuation { continuation in
            submit(.dispatch(["type": "history_page", "body": .array(records.map(JSONValue.object))], owner: owner, continuation))
        }
    }

    /// The latest page (or the window around a found message) of `conversation` replaces what was
    /// cached: messages in `stale` (shown before the request) that the page no longer has are dropped,
    /// then the page is applied as `history_page`. Throws while the store is unavailable.
    @discardableResult
    public func replaceHistory(_ conversation: String, records: [JSONObject], stale: Set<Int64>, owner: Int64? = nil) async throws -> Outcome {
        try await withCheckedThrowingContinuation { continuation in
            submit(.replaceHistory(conversation, records, stale, owner: owner, continuation))
        }
    }

    /// `background_flush` (§6.2): the heads go over HTTP while there is no socket.
    @discardableResult
    public func backgroundFlush() async -> Outcome {
        await dispatch(["type": "background_flush"])
    }

    /// The model belongs to `userId` from now on: another account's outbox, ops and cache are wiped
    /// first. Throws when that wipe failed (it is retried; nothing of the old account is sent meanwhile).
    public func adopt(_ userId: Int64) async throws {
        try await withCheckedThrowingContinuation { continuation in
            submit(.adopt(userId, continuation))
        }
    }

    /// Explicit sign-out or account deletion: the model and its storage are wiped, its requests and
    /// alarms dropped. Throws when the store could not be emptied.
    public func reset() async throws {
        try await withCheckedThrowingContinuation { continuation in
            submit(.reset(continuation))
        }
    }

    /// Waits until `predicate` holds for the model (checked now and after every step), at most
    /// `timeoutMs` on the engine's clock. False on timeout.
    public func wait(timeoutMs: Int64, until predicate: @escaping (DeliveryState) -> Bool) async -> Bool {
        if predicate(state) { return true }
        let id = UUID()
        let clock = self.clock
        let timer = Task { [weak self] in
            try? await clock.sleep(milliseconds: timeoutMs)
            self?.finishWaiter(id, result: false)
        }
        let result = await withCheckedContinuation { continuation in
            stateWaiters[id] = (predicate, continuation)
        }
        timer.cancel()
        return result
    }

    private func finishWaiter(_ id: UUID, result: Bool) {
        stateWaiters.removeValue(forKey: id)?.continuation.resume(returning: result)
    }

    private func setState(_ newState: DeliveryState) {
        state = newState
        for handler in onStateChange { handler(newState) }
        for (id, waiter) in stateWaiters where waiter.predicate(newState) {
            finishWaiter(id, result: true)
        }
    }

    // MARK: - Commands

    private func run(_ command: Command) async {
        switch command {
        case .restore:
            await restore()
        case .retryWipe:
            guard blocked == "wipe", await clearStore() == nil else { return }
            if let signedIn { _ = await claimFor(signedIn) }
            // A socket that came up meanwhile was refused: pick it up for its own account.
            if let id = await link.authenticatedUserId(), await claimFor(id) == nil, blocked == nil {
                _ = await process(authSuccess(id))
            }
        case .dispatch(let event, let owner, let continuation):
            // Evaluated first: optional chaining would skip the whole call for a posted event.
            let outcome = await dispatchNow(event, owner: owner)
            continuation?.resume(returning: outcome)
        case .replaceHistory(let conversation, let records, let stale, let owner, let continuation):
            guard blocked == nil else {
                continuation.resume(throwing: EngineError.storeUnavailable(blocked ?? ""))
                return
            }
            // Only the signed-in account's pages enter its model; a late page of another is dropped.
            guard !signedOut, owner.map(ownerMatches) ?? true else {
                log("a history page of another account was dropped")
                continuation.resume(throwing: EngineError.notTheSignedInAccount)
                return
            }
            if let owner, state.me == nil { _ = await claimFor(owner) }
            if let list = state.messages[conversation] {
                let pageIds = Set(records.compactMap { $0["id"]?.int64 })
                let kept = list.filter { !stale.contains($0.id) || pageIds.contains($0.id) }
                if kept.count != list.count {
                    var trimmed = state
                    trimmed.messages[conversation] = kept.isEmpty ? nil : kept
                    dirtyCache.insert(conversation)
                    setState(trimmed)
                }
            }
            continuation.resume(returning: await process(["type": "history_page", "body": .array(records.map(JSONValue.object))]))
        case .reset(let continuation):
            // Explicit sign-out or account deletion: the disk first. If it cannot be emptied the
            // sign-out is cancelled, so nothing is touched — the model stays as it was and keeps
            // going out for the account that is still signed in; no wipe is retried behind its back.
            do {
                try await store.clear()
            } catch {
                log("the unsent messages could not be deleted; the sign-out is cancelled: \(error)")
                continuation.resume(throwing: error)
                return
            }
            signedIn = nil
            signedOut = true
            forgetInMemory()
            blocked = nil
            repairAttempts = 0
            markReady()
            continuation.resume()
        case .adopt(let userId, let continuation):
            signedIn = userId
            let wasSignedOut = signedOut
            signedOut = false
            // While the store cannot be read, the owner is checked once it can (restore).
            if blocked != "load", let error = await claimFor(userId) {
                continuation.resume(throwing: error)
                return
            }
            // A socket that authenticated while the model was signed out was ignored: take it up now.
            if wasSignedOut, blocked == nil, state.connection != DeliveryState.online,
               let id = await link.authenticatedUserId(), id == userId {
                _ = await process(authSuccess(id))
            }
            continuation.resume()
        case .closeIfVisible(let conversation):
            guard blocked == nil, state.visible == conversation else { return }
            _ = await process(["type": "conversation_closed"])
        case .flushCache:
            cacheFlushScheduled = false
            guard blocked == nil, !dirtyCache.isEmpty else { return }
            let cache = takeDirtyCache(state)
            do {
                try await store.writeCache(cache, me: state.me)
            } catch {
                log("delivery cache write failed: \(error)")
            }
        }
    }

    private func dispatchNow(_ event: JSONObject, owner: Int64?) async -> Outcome {
        // Refused, not lost: the composer keeps the text; frames come again with the next sync.
        guard blocked == nil else { return .refused }
        let type = event["type"]?.string ?? ""
        if signedOut && (owner != nil || Self.takenOnlyForAnAccount.contains(type)) {
            // After an explicit sign-out nothing is taken before an account is adopted.
            return .refused
        }
        // A stated owner must be the signed-in account (an answer that arrives after a switch is not).
        if let owner {
            guard ownerMatches(owner) else {
                log("an action of another account was refused (\(type))")
                return .refused
            }
            if state.me == nil { _ = await claimFor(owner) }
        }
        // A socket of another account: that account never sees, nor sends, this one's data.
        if let user = authenticatedAs(event) { _ = await claimFor(user) }
        if type == "enqueue" {
            // A new entry is always stamped with its account; without one it is not taken.
            if owner == nil && state.me == nil {
                guard let signedIn else { return .refused }
                _ = await claimFor(signedIn)
            }
            if state.me == nil { return .refused }
        }
        guard blocked == nil else { return .refused }
        return await process(event)
    }

    /// `owner` may act on the model now: it is the signed-in account (when one is known) and the
    /// model's own account (when it has one). Never a reason to wipe the model.
    private func ownerMatches(_ owner: Int64) -> Bool {
        (signedIn == nil || signedIn == owner) && (state.me == nil || state.me == owner)
    }

    /// The model is `user`'s: another account's queue — or one that names no account but holds
    /// something — is wiped first; an empty model is claimed. The failure of a wipe, or nil.
    private func claimFor(_ user: Int64) async -> (any Error)? {
        let me = state.me
        let ownerless = me == nil && (!state.outbox.isEmpty || !state.ops.isEmpty || !state.cancelled.isEmpty || !state.messages.isEmpty)
        if (me != nil && me != user) || ownerless {
            if let error = await wipe() { return error }
        }
        if blocked == nil && state.me == nil {
            // Stored with the next persist; until then nothing of this account is on disk anyway.
            var claimed = state
            claimed.me = user
            setState(claimed)
        }
        return nil
    }

    /// Forgets everything of another account — in memory at once (so nothing of it can be sent under
    /// this one), then on disk. A failed delete keeps the engine blocked and retries; the caller hears of it.
    private func wipe() async -> (any Error)? {
        forgetInMemory()
        return await clearStore()
    }

    private func forgetInMemory() {
        for task in work.values { task.cancel() }
        work.removeAll()
        epoch += 1
        alarms.removeAll()
        dirtyCache.removeAll()
        setState(DeliveryState())
        for handler in onWipe { handler() }
    }

    /// Nil when the store is empty now; otherwise the failure (the engine stays blocked and retries).
    private func clearStore() async -> (any Error)? {
        do {
            try await store.clear()
            blocked = nil
            repairAttempts = 0
            // The store is empty and readable now: whatever blocked the engine (a failed load) is over.
            markReady()
            return nil
        } catch {
            log("delivery store could not be wiped: \(error)")
            blocked = "wipe"
            scheduleRepair(.retryWipe)
            return error
        }
    }

    private func scheduleRepair(_ command: Command) {
        repairAttempts += 1
        let wait = DeliveryReducer.backoff(min(repairAttempts, 6))
        let clock = self.clock
        launch { [weak self] in
            try? await clock.sleep(milliseconds: wait)
            guard !Task.isCancelled else { return }
            self?.submit(command)
        }
    }

    /// The user id of an `auth_success` frame event, else nil.
    private func authenticatedAs(_ event: JSONObject) -> Int64? {
        guard event["type"]?.string == "ws", let frame = event["frame"]?.object,
              frame["type"]?.string == "auth_success" else { return nil }
        return frame["user"]?["id"]?.int64
    }

    private func restore() async {
        var stored: StoredDelivery
        do {
            stored = try await store.load()
        } catch {
            // Fail closed: an empty model now would overwrite the outbox on disk with the next persist.
            log("delivery store could not be read: \(error)")
            blocked = "load"
            scheduleRepair(.restore)
            return
        }
        blocked = nil
        repairAttempts = 0
        // The owner rule before anything is published: another account's model (or one that names no
        // account but holds something) is deleted unseen when an account is known.
        let authenticated = await link.authenticatedUserId()
        if let target = signedIn ?? authenticated {
            let holds = !stored.outbox.isEmpty || !stored.ops.isEmpty || !stored.cancelled.isEmpty || !stored.cache.isEmpty
            if (stored.me != nil && stored.me != target) || (stored.me == nil && holds) {
                do {
                    try await store.clear()
                } catch {
                    log("another account's stored model could not be deleted: \(error)")
                    blocked = "wipe"
                    scheduleRepair(.retryWipe)
                    return
                }
                for handler in onWipe { handler() }
                stored = StoredDelivery()
            }
        }
        var restored = DeliveryState(me: stored.me)
        restored.sync.cursor = stored.cursor
        restored.seq = stored.seq
        restored.outbox = stored.outbox
        restored.ops = stored.ops
        restored.cancelled = stored.cancelled
        setState(restored)
        _ = await process(["type": "app_restart"])
        // The cache fills the model again (§6.3 app_restart).
        for conversation in stored.cache.keys.sorted() {
            guard let records = stored.cache[conversation], !records.isEmpty else { continue }
            _ = await process(["type": "history_page", "body": .array(records.map(JSONValue.object))], cacheWrite: false)
        }
        // The owner rule of a live auth_success applies to what was just read: a queue of another
        // account (signed in meanwhile, or with a socket already up) is wiped, never sent or synced.
        if let signedIn { _ = await claimFor(signedIn) }
        if let authenticated { _ = await claimFor(authenticated) }
        guard blocked == nil else { return }
        markReady()
        // Started while a socket was already up (it never sends auth_success again).
        if let authenticated { _ = await process(authSuccess(authenticated)) }
    }

    private func nextNow() -> Int64 {
        lastNow = max(lastNow, clock.now())
        return lastNow
    }

    private func process(_ event: JSONObject, cacheWrite: Bool = true) async -> Outcome {
        var ev = event
        if ev["now"] == nil { ev["now"] = .int(nextNow()) }
        let type = ev["type"]?.string ?? ""
        let before = state
        let step = DeliveryReducer.reduce(before, ev)
        if cacheWrite && Self.messageEvents.contains(type) { trackCache(before, step.state) }

        if case .persist(let slices)? = step.effects.first {
            do {
                try await store.persist(slices: slices, state: step.state, cache: takeDirtyCache(step.state))
                diskFailures = 0
            } catch {
                log("delivery persist failed (\(type)): \(error)")
                onPersistFailed(ev, type)
                return Outcome(persisted: false, effects: step.effects)
            }
        } else if !dirtyCache.isEmpty {
            scheduleCacheFlush()
        }
        setState(step.state)
        for effect in step.effects {
            await execute(effect)
        }
        return Outcome(persisted: true, effects: step.effects)
    }

    /// §5: the new state is dropped; what happens next depends on who sent the event.
    private func onPersistFailed(_ ev: JSONObject, _ type: String) {
        if Self.userEvents.contains(type) {
            return // the caller shows the error; the composer keeps its text
        }
        let clock = self.clock
        let link = self.link
        if Self.serverEvents.contains(type) {
            // The next sync chain returns the same data (the cursor did not move); a disk that keeps
            // failing is not hammered: the socket restarts after a growing pause.
            diskFailures += 1
            let wait = diskFailures > 1 ? DeliveryReducer.backoff(diskFailures - 1) : 0
            launch {
                try? await clock.sleep(milliseconds: wait)
                guard !Task.isCancelled else { return }
                await link.restart()
            }
            return
        }
        var again = ev
        again["now"] = nil
        let retry = again
        launch { [weak self] in
            try? await clock.sleep(milliseconds: Self.persistRetryMs)
            guard !Task.isCancelled else { return }
            self?.post(retry)
        }
    }

    /// Runs `body` as work of the current account (cancelled by a wipe).
    private func launch(_ body: @escaping @MainActor @Sendable () async -> Void) {
        let id = UUID()
        let session = epoch
        work[id] = Task { [weak self] in
            await body()
            guard let self, self.epoch == session else { return }
            self.work[id] = nil
        }
    }

    private func execute(_ effect: DeliveryEffect) async {
        let session = epoch
        let clock = self.clock
        let backend = self.backend
        switch effect {
        case .persist, .clearComposer:
            return
        case .sendWs(let frame):
            // A refused write means there is no authenticated socket: treat it as gone now.
            let written = await link.send(frame)
            if !written { post(["type": "ws_disconnected"]) }
        case .sendHttp(let clientMsgId, let attempt, _, let path, let body):
            launch { [weak self] in
                let result = await backend.post(path: path, body: body)
                guard let self, self.epoch == session else { return }
                self.post([
                    "type": "http_send_result",
                    "client_msg_id": .string(clientMsgId),
                    "attempt": .int(attempt),
                    "status": .int(Int64(result.status)),
                    "body": result.body ?? .null,
                ])
            }
        case .schedule(let at, let event):
            // Identical alarms collapse; stale ones are harmless (§6.5).
            let key = "\(at)|\(JSONValue.object(event).jsonText)"
            guard alarms.insert(key).inserted else { return }
            launch { [weak self] in
                try? await clock.sleep(milliseconds: at - clock.now())
                guard let self, !Task.isCancelled, self.epoch == session else { return }
                self.alarms.remove(key)
                self.post(event)
            }
        case .syncRequest(let cursor, let limit, let chain):
            launch { [weak self] in
                let outcome = await backend.sync(cursor: cursor, limit: limit)
                guard let self, self.epoch == session else { return }
                switch outcome {
                case .page(let body):
                    self.post(["type": "sync_page", "chain": .int(chain), "body": .object(body)])
                case .cursorInvalid(let body):
                    self.post(["type": "sync_reset_410", "chain": .int(chain), "body": .object(body)])
                case .failed(let status, let retryAfterMs):
                    var event: JSONObject = ["type": "sync_failed", "chain": .int(chain), "status": .int(Int64(status))]
                    if let retryAfterMs { event["retry_after_ms"] = .int(retryAfterMs) }
                    self.post(event)
                }
            }
        case .refreshConversationLists:
            launch { [weak self] in
                let snapshot: UnreadSnapshot
                do {
                    snapshot = try await backend.unreadSnapshot()
                } catch {
                    self?.log("conversation lists unavailable: \(error)")
                    return
                }
                guard let self, self.epoch == session else { return }
                var event: JSONObject = ["type": "unread_snapshot", "counts": .object(snapshot.counts.mapValues(JSONValue.int))]
                if !snapshot.lastMessageIds.isEmpty {
                    event["last_message_ids"] = .object(snapshot.lastMessageIds.mapValues { JSONValue.orNull($0) })
                }
                self.post(event)
            }
        case .loadHistory(let conversation):
            launch { [weak self] in
                let page: [JSONObject]
                do {
                    page = try await backend.history(conversation)
                } catch {
                    self?.log("history of \(conversation) unavailable: \(error)")
                    return
                }
                guard let self, self.epoch == session else { return }
                self.post(["type": "history_page", "body": .array(page.map(JSONValue.object))])
            }
        case .userError(let code):
            errorSerial += 1
            lastUserError = UserError(code: code, serial: errorSerial)
            for handler in onUserError { handler(code) }
        }
    }

    // MARK: - Conversation cache

    private func trackCache(_ before: DeliveryState, _ after: DeliveryState) {
        for conversation in Set(before.messages.keys).union(after.messages.keys)
        where before.messages[conversation] != after.messages[conversation] {
            dirtyCache.insert(conversation)
        }
    }

    private func takeDirtyCache(_ state: DeliveryState) -> [String: [JSONObject]] {
        guard !dirtyCache.isEmpty else { return [:] }
        var cache: [String: [JSONObject]] = [:]
        for conversation in dirtyCache {
            cache[conversation] = (state.messages[conversation] ?? []).suffix(DeliveryCache.perConversation).map(\.mergedRecord)
        }
        dirtyCache.removeAll()
        return cache
    }

    private func scheduleCacheFlush() {
        guard !cacheFlushScheduled else { return }
        cacheFlushScheduled = true
        let clock = self.clock
        let delay = cacheDelayMs
        launch { [weak self] in
            try? await clock.sleep(milliseconds: delay)
            guard !Task.isCancelled else { return }
            self?.submit(.flushCache)
        }
    }

    // MARK: - Events

    private func authSuccess(_ userId: Int64) -> JSONObject {
        ["type": "ws", "frame": ["type": "auth_success", "user": ["id": .int(userId)]]]
    }

    static let persistRetryMs: Int64 = 1_000
    private static let userEvents: Set<String> = ["enqueue", "edit", "delete", "cancel", "retry"]
    /// Events that need an account: refused after an explicit sign-out until one is adopted.
    private static let takenOnlyForAnAccount: Set<String> = [
        "ws", "enqueue", "edit", "delete", "cancel", "retry", "history_page", "sync_page", "sync_reset_410",
        "http_send_result", "unread_snapshot", "background_flush",
    ]
    private static let serverEvents: Set<String> = ["ws", "sync_page", "sync_reset_410", "sync_failed", "history_page", "http_send_result", "unread_snapshot"]
    private static let messageEvents: Set<String> = ["ws", "sync_page", "sync_reset_410", "history_page", "http_send_result"]

    /// Canonical lower-case UUID v4 (§7.1).
    public nonisolated static func newClientMsgId() -> String {
        UUID().uuidString.lowercased()
    }
}
