import Foundation

/// The client delivery reducer — `mobile/contracts/delivery-state.md`, ported line by line from the
/// reference `mobile/contracts/reference/delivery-reducer.mjs` (every vector in
/// `fixtures/reducers/` must pass). Pure: no clock, no randomness, no I/O.
///
///     reduce(state, event) -> (state, effects)
///
/// Events and server frames are the contract's JSON as is (§4); section numbers refer to the contract.
public enum DeliveryReducer {
    public static let maxTextLength = 16_000
    public static let ackTimeoutMs: Int64 = 10_000
    public static let httpAckTimeoutMs: Int64 = 30_000
    public static let maxAttempts: Int64 = 5
    public static let sendRateMax = 8
    public static let sendRateWindowMs: Int64 = 1_000
    public static let opsRateMax = 8
    public static let opsRateWindowMs: Int64 = 1_000
    public static let syncPageLimit: Int64 = 200
    public static let syncRetryMs: Int64 = 5_000
    public static let keyErrors: Set<String> = ["CLIENT_MSG_ID_CONFLICT", "INVALID_CLIENT_MSG_ID", "CANCELLED"]
    public static let cancelledMax = 100
    public static let rateLimitedRetryMs: Int64 = 1_000
    public static let rateLimitedMaxRetryMs: Int64 = 30_000

    /// ECMAScript WhiteSpace + LineTerminator — exactly what the server's `trim()` removes (§6.1).
    private static func isContractWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    private static let msgTypes: Set<String> = ["text", "file", "image"]
    private static let statusRank = ["sent": 1, "delivered": 2, "read": 3]

    public static func backoff(_ failures: Int64) -> Int64 {
        let exponent = max(0, min(30, failures - 1))
        return min(1_000 * (Int64(1) << exponent), 30_000)
    }

    /// Whether `text` counts as empty for a text message (§6.1).
    public static func isBlank(_ text: String) -> Bool {
        text.unicodeScalars.allSatisfy(isContractWhitespace)
    }

    /// `^[A-Za-z0-9_-]{1,64}$`.
    public static func isValidClientMsgId(_ value: String) -> Bool {
        guard (1...64).contains(value.utf16.count) else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            switch scalar {
            case "A"..."Z", "a"..."z", "0"..."9", "_", "-": return true
            default: return false
            }
        }
    }

    /// `^(direct|channel):[1-9][0-9]*$`.
    public static func isValidConversation(_ value: String) -> Bool {
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0] == "direct" || parts[0] == "channel" else { return false }
        let digits = parts[1].unicodeScalars
        guard let first = digits.first, ("1"..."9").contains(first) else { return false }
        return digits.allSatisfy { ("0"..."9").contains($0) }
    }

    /// Applies one event (§6). The input state is never changed; `persist` (when needed) comes first.
    public static func reduce(_ input: DeliveryState, _ event: JSONObject) -> (state: DeliveryState, effects: [DeliveryEffect]) {
        var state = input
        var effects: [DeliveryEffect] = []
        let now = event["now"]?.int64 ?? 0
        handle(&state, event, now, &effects)
        pump(&state, now, &effects)

        var slices: [String] = []
        if state.cancelled != input.cancelled { slices.append("cancelled") }
        if state.sync.cursor != input.sync.cursor { slices.append("cursor") }
        if state.ops != input.ops { slices.append("ops") }
        if state.seq != input.seq || state.outbox != input.outbox { slices.append("outbox") }
        if !slices.isEmpty { effects.insert(.persist(slices: slices), at: 0) }
        return (state, effects)
    }

    // MARK: - Helpers

    static func parseConversation(_ conv: String) -> (conversationType: String, targetId: Int64) {
        let parts = conv.split(separator: ":", omittingEmptySubsequences: false)
        let type = parts.first.map(String.init) ?? ""
        let id = parts.count > 1 ? Int64(parts[1]) ?? 0 : 0
        return (type, id)
    }

    /// JavaScript template-literal text of a JSON value.
    private static func raw(_ value: JSONValue?) -> String {
        guard let value else { return "undefined" }
        switch value {
        case .null: return "null"
        case .string(let text): return text
        case .number(let number):
            if let integer = value.int64 { return String(integer) }
            return String(number)
        case .bool(let flag): return flag ? "true" : "false"
        case .array, .object: return value.jsonText
        }
    }

    /// `direct:<peer>` or `channel:<id>` of a server record (§2).
    public static func conversationOf(_ rec: JSONObject, me: Int64?) -> String {
        if rec["conversation_type"]?.string == "channel" { return "channel:\(raw(rec["target_id"]))" }
        let own = me != nil && (rec["sender_id"]?.double ?? .nan) == Double(me ?? 0)
        let partner = own ? rec["target_id"] : rec["sender_id"]
        return "direct:\(raw(partner))"
    }

    /// Validates text the same way for enqueue and edit; a user_error code or nil.
    private static func textError(_ text: JSONValue?, _ msgType: String) -> String? {
        guard let value = text?.string else { return "EMPTY_TEXT" }
        if msgType == "text" && isBlank(value) { return "EMPTY_TEXT" }
        if value.utf16.count > maxTextLength { return "TEXT_TOO_LONG" } // UTF-16 code units
        return nil
    }

    /// `Date.parse` of an ISO time: -infinity for nil, NaN when unreadable.
    static func instant(_ iso: String?) -> Double {
        guard let iso else { return -.infinity }
        return ISOInstant.milliseconds(iso) ?? .nan
    }

    private static func statusFromRecord(_ rec: JSONObject, _ conv: String) -> String {
        if conv.hasPrefix("channel:") { return "sent" }
        switch rec["delivery_status"]?.string {
        case "read": return "read"
        case "delivered": return "delivered"
        default: return "sent"
        }
    }

    private static func maxStatus(_ a: String?, _ b: String?) -> String? {
        (statusRank[b ?? ""] ?? 0) > (statusRank[a ?? ""] ?? 0) ? b : a
    }

    /// The contract projection of a server record (§3.3); the record itself rides along for the screen.
    static func project(_ rec: JSONObject, status: String?) -> Msg {
        Msg(
            id: rec["id"]?.int64 ?? 0,
            clientMsgId: rec["client_msg_id"]?.string,
            senderId: rec["sender_id"]?.int64 ?? 0,
            text: rec["text"]?.string ?? "",
            type: rec["type"]?.string ?? "text",
            replyToId: rec["reply_to_id"]?.int64,
            metadataJson: rec["metadata_json"]?.string,
            createdAt: rec["created_at"]?.string,
            updatedAt: rec["updated_at"]?.string,
            isDeleted: (rec["is_deleted"]?.isTruthy ?? false) ? 1 : 0,
            status: status,
            record: rec
        )
    }

    /// Copies the content fields (§7.9) of `from` into `into`.
    private static func takeContent(_ into: inout Msg, _ from: Msg) {
        into.text = from.text
        into.type = from.type
        into.replyToId = from.replyToId
        into.metadataJson = from.metadataJson
        into.createdAt = from.createdAt
        into.updatedAt = from.updatedAt
        into.isDeleted = from.isDeleted
        into.record = from.record
    }

    static func sendMessageFrame(_ e: OutboxEntry) -> JSONObject {
        let c = parseConversation(e.conversation)
        return [
            "type": "send_message",
            "conversationType": .string(c.conversationType),
            "targetId": .int(c.targetId),
            "text": .string(e.text),
            "msgType": .string(e.msgType),
            "replyToId": .orNull(e.replyToId),
            "metadata": e.metadata ?? .null,
            "client_msg_id": .string(e.clientMsgId),
        ]
    }

    private static func opFrame(_ op: DeliveryOp) -> JSONObject {
        switch op.op {
        case DeliveryOp.edit:
            return ["type": "edit_message", "messageId": .orNull(op.messageId), "text": .orNull(op.text)]
        case DeliveryOp.cancel:
            return ["type": "cancel_message", "client_msg_id": .orNull(op.clientMsgId)]
        default:
            return ["type": "delete_message", "messageId": .orNull(op.messageId)]
        }
    }

    /// Event of the op_timeout alarm: delete ops are keyed by message_id, cancel ops by client_msg_id.
    private static func opTimeoutEvent(_ op: DeliveryOp) -> JSONObject {
        if op.op == DeliveryOp.cancel {
            return ["type": "op_timeout", "client_msg_id": .orNull(op.clientMsgId), "attempt": .int(op.attempts)]
        }
        return ["type": "op_timeout", "message_id": .orNull(op.messageId), "attempt": .int(op.attempts)]
    }

    static func markReadFrame(_ conv: String) -> JSONObject {
        let c = parseConversation(conv)
        return ["type": "mark_read", "conversationType": .string(c.conversationType), "targetId": .int(c.targetId)]
    }

    private static func ackTimeoutEvent(_ e: OutboxEntry) -> JSONObject {
        ["type": "ack_timeout", "client_msg_id": .string(e.clientMsgId), "attempt": .int(e.attempts)]
    }

    private static func findMessage(_ state: DeliveryState, _ id: Int64?) -> (conv: String, index: Int)? {
        guard let id else { return nil }
        // Keys in a fixed order, so a duplicate id (never sent by the server) resolves the same way every time.
        for conv in state.messages.keys.sorted() {
            if let index = state.messages[conv]?.firstIndex(where: { $0.id == id }) { return (conv, index) }
        }
        return nil
    }

    private static func cmidInUse(_ state: DeliveryState, _ cmid: String) -> Bool {
        if state.outbox.contains(where: { $0.clientMsgId == cmid }) { return true }
        if state.cancelled.contains(cmid) { return true }
        return state.messages.values.contains { list in list.contains { $0.senderId == state.me && $0.clientMsgId == cmid } }
    }

    private static func entryIndex(_ state: DeliveryState, _ cmid: String?) -> Int? {
        guard let cmid else { return nil }
        return state.outbox.firstIndex { $0.clientMsgId == cmid }
    }

    private static func removeEntry(_ state: inout DeliveryState, _ cmid: String) {
        state.outbox.removeAll { $0.clientMsgId == cmid }
    }

    private static func deleteOpIndex(_ state: DeliveryState, _ id: Int64?) -> Int? {
        guard let id else { return nil }
        return state.ops.firstIndex { $0.op == DeliveryOp.delete && $0.messageId == id }
    }

    private static func cancelOpIndex(_ state: DeliveryState, _ cmid: String?) -> Int? {
        guard let cmid else { return nil }
        return state.ops.firstIndex { $0.op == DeliveryOp.cancel && $0.clientMsgId == cmid }
    }

    /// The edit of message `id` that was sent last and is not confirmed yet (§3.2): at most one per message.
    private static func sentEditIndex(_ state: DeliveryState, _ id: Int64?) -> Int? {
        guard let id else { return nil }
        return state.ops.firstIndex { $0.op == DeliveryOp.edit && $0.state == OutboxEntry.sending && $0.messageId == id }
    }

    private static func addDeleteOp(_ state: inout DeliveryState, _ id: Int64) {
        if deleteOpIndex(state, id) == nil { state.ops.append(DeliveryOp(op: DeliveryOp.delete, messageId: id, text: nil)) }
    }

    private static func addCancelOp(_ state: inout DeliveryState, _ cmid: String) {
        if cancelOpIndex(state, cmid) == nil {
            state.ops.append(DeliveryOp(op: DeliveryOp.cancel, messageId: nil, clientMsgId: cmid, text: nil))
        }
    }

    /// Keys of cancelled entries dropped without proof (§7.10): bounded, oldest out first.
    private static func rememberCancelled(_ state: inout DeliveryState, _ cmid: String) {
        if !state.cancelled.contains(cmid) { state.cancelled.append(cmid) }
        if state.cancelled.count > cancelledMax { state.cancelled = Array(state.cancelled.suffix(cancelledMax)) }
    }

    private static func forgetCancelled(_ state: inout DeliveryState, _ cmid: String) {
        state.cancelled.removeAll { $0 == cmid }
    }

    /// Once a record with the key is known the message has a server id: a delete op replaces the cancel op.
    private static func dropCancelOp(_ state: inout DeliveryState, _ cmid: String) {
        if let index = cancelOpIndex(state, cmid) { state.ops.remove(at: index) }
    }

    /// A tombstone confirms the delete (and makes any pending edit pointless) — §6.3.
    private static func confirmDeleted(_ state: inout DeliveryState, _ id: Int64) {
        state.ops.removeAll { $0.messageId == id }
    }

    // MARK: - Sync chains (§6.3, §7.11)

    private static func startSync(_ state: inout DeliveryState, _ effects: inout [DeliveryEffect]) {
        state.sync.chain += 1
        state.sync.running = true
        state.sync.bootstrap = state.sync.cursor == nil
        effects.append(.syncRequest(cursor: state.sync.cursor, limit: syncPageLimit, chain: state.sync.chain))
    }

    private static func maybeStartSync(_ state: inout DeliveryState, _ effects: inout [DeliveryEffect]) {
        if state.connection == DeliveryState.online && !state.sync.running { startSync(&state, &effects) }
    }

    private static func currentChain(_ state: DeliveryState, _ ev: JSONObject) -> Bool {
        state.sync.running && ev["chain"]?.int64 == state.sync.chain
    }

    // MARK: - Outcomes of an attempt (§6.3)

    private static func reject(_ state: inout DeliveryState, _ i: Int, _ code: String?, _ message: String?) {
        if state.outbox[i].pendingDelete {
            state.outbox.remove(at: i)
            return
        }
        var e = state.outbox[i]
        e.state = OutboxEntry.failed
        e.failure = DeliveryFailure(reason: DeliveryFailure.rejected, code: code, message: message)
        e.maybeStored = false
        e.transport = nil
        e.ackDeadline = nil
        e.nextAttemptAt = nil
        if let edit = e.pendingEdit {
            e.text = edit
            e.pendingEdit = nil
        }
        state.outbox[i] = e
    }

    private static func attemptFailed(_ state: inout DeliveryState, _ i: Int, _ now: Int64, _ effects: inout [DeliveryEffect]) {
        state.outbox[i].transport = nil
        state.outbox[i].ackDeadline = nil
        if state.outbox[i].pendingDelete {
            // Never sent again (§7.10); find out via sync.
            state.outbox[i].state = OutboxEntry.queued
            state.outbox[i].nextAttemptAt = nil
            maybeStartSync(&state, &effects)
            return
        }
        state.outbox[i].failures += 1
        if state.outbox[i].failures >= maxAttempts {
            state.outbox[i].state = OutboxEntry.failed
            state.outbox[i].failure = DeliveryFailure(reason: DeliveryFailure.maxAttempts, code: nil, message: nil)
            state.outbox[i].nextAttemptAt = nil
        } else {
            state.outbox[i].state = OutboxEntry.queued
            state.outbox[i].nextAttemptAt = now + backoff(state.outbox[i].failures)
        }
    }

    /// Frame dropped by the server's rate limit (§7.3): not processed; retry after the pause, budget untouched.
    private static func attemptRateLimited(_ state: inout DeliveryState, _ i: Int, _ now: Int64, _ retryAfterMs: Int64, _ effects: inout [DeliveryEffect]) {
        if state.outbox[i].pendingDelete {
            attemptFailed(&state, i, now, &effects)
            return
        }
        state.outbox[i].state = OutboxEntry.queued
        state.outbox[i].transport = nil
        state.outbox[i].ackDeadline = nil
        state.outbox[i].nextAttemptAt = now + retryAfterMs
    }

    /// Attempt cut off by disconnect/restart/401: back to queued, budget untouched (§7.3).
    private static func attemptInterrupted(_ e: inout OutboxEntry) {
        e.state = OutboxEntry.queued
        e.transport = nil
        e.ackDeadline = nil
        e.nextAttemptAt = nil
    }

    // MARK: - Ingest of a server record (§6.3, §7.6–7.9)

    private static func ingest(_ state: inout DeliveryState, _ rec: JSONObject, _ source: String, _ effects: inout [DeliveryEffect]) {
        let conv = conversationOf(rec, me: state.me)
        let own = state.me != nil && (rec["sender_id"]?.double ?? .nan) == Double(state.me ?? 0)
        let deleted = rec["is_deleted"]?.isTruthy ?? false
        let recId = rec["id"]?.int64
        var reconciled = false

        let recKey = rec["client_msg_id"]?.string
        if own, let recKey {
            if let i = entryIndex(state, recKey) {
                let e = state.outbox[i]
                removeEntry(&state, e.clientMsgId)
                reconciled = true
                dropCancelOp(&state, e.clientMsgId) // stored: the delete op below (or the tombstone) settles it
                if !deleted, let recId {
                    if e.pendingDelete {
                        addDeleteOp(&state, recId)
                    } else if let edit = e.pendingEdit, edit != rec["text"]?.string {
                        state.ops.append(DeliveryOp(op: DeliveryOp.edit, messageId: recId, text: edit))
                    }
                }
            } else if state.cancelled.contains(recKey) {
                // A cancelled message dropped locally without proof turned up after all (§7.10).
                forgetCancelled(&state, recKey)
                dropCancelOp(&state, recKey)
                if !deleted, let recId { addDeleteOp(&state, recId) }
            }
        }

        var list = state.messages[conv] ?? []
        var inserted = false
        if let index = list.firstIndex(where: { recId != nil && $0.id == recId }) {
            var existing = list[index]
            if deleted {
                takeContent(&existing, project(rec, status: nil))
            } else if existing.isDeleted == 0 && instant(rec["updated_at"]?.string) >= instant(existing.updatedAt) {
                takeContent(&existing, project(rec, status: nil))
            }
            existing.clientMsgId = existing.clientMsgId ?? recKey
            if own { existing.status = maxStatus(existing.status, statusFromRecord(rec, conv)) }
            list[index] = existing
            state.messages[conv] = list
        } else if source != "update" || reconciled {
            list.append(project(rec, status: own ? statusFromRecord(rec, conv) : nil))
            list.sort { $0.id < $1.id }
            state.messages[conv] = list
            inserted = true
        }

        if deleted {
            if let recId { confirmDeleted(&state, recId) }
        } else if let sent = sentEditIndex(state, recId), state.ops[sent].text == rec["text"]?.string {
            state.ops.remove(at: sent) // the sent edit is applied (§7.10)
        }

        if source == "live" && inserted && !deleted {
            if own {
                if conv.hasPrefix("channel:") { state.unread[conv] = nil }
            } else if conv == state.visible {
                if state.connection == DeliveryState.online { effects.append(.sendWs(frame: markReadFrame(conv))) }
            } else {
                state.unread[conv, default: 0] += 1
            }
        }
    }

    // MARK: - Pump and background flush (§6.2)

    /// Indices of the heads of each conversation that may be sent now, in seq order.
    private static func eligibleHeads(_ state: DeliveryState, _ now: Int64, _ onWait: (Int64) -> Void) -> [Int] {
        let busy = Set(state.outbox.filter { $0.state == OutboxEntry.sending && !$0.pendingDelete }.map(\.conversation))
        var occupied = Set<String>()
        var heads: [Int] = []
        for (i, e) in state.outbox.enumerated() {
            if e.pendingDelete || e.state == OutboxEntry.failed || occupied.contains(e.conversation) { continue }
            occupied.insert(e.conversation)
            if e.state != OutboxEntry.queued || busy.contains(e.conversation) { continue }
            if let next = e.nextAttemptAt, next > now {
                onWait(next)
                continue
            }
            heads.append(i)
        }
        return heads
    }

    private static func pump(_ state: inout DeliveryState, _ now: Int64, _ effects: inout [DeliveryEffect]) {
        guard state.connection == DeliveryState.online, !state.sync.running else { return }
        if let wake = state.wakeAt, wake <= now { state.wakeAt = nil }
        state.sendLog = state.sendLog.filter { now - $0 < sendRateWindowMs }
        state.opsLog = state.opsLog.filter { now - $0 < opsRateWindowMs }

        var wakeAt: Int64?
        let wake: (Int64) -> Void = { t in wakeAt = wakeAt.map { min($0, t) } ?? t }

        var sentEdits: [Int64?: Int] = [:] // message_id -> index of the edit op sent by this pump
        for i in state.ops.indices {
            let op = state.ops[i]
            if op.state != OutboxEntry.queued { continue }
            if let next = op.nextAttemptAt, next > now {
                wake(next)
                continue
            }
            if state.opsLog.count >= opsRateMax {
                wake(state.opsLog[0] + opsRateWindowMs)
                continue
            }
            state.opsLog.append(now)
            state.ops[i].attempts += 1
            effects.append(.sendWs(frame: opFrame(state.ops[i])))
            if op.op == DeliveryOp.edit {
                // No ack timeout: an edit is not resent on silence (§7.10); it waits for confirmation.
                state.ops[i].state = OutboxEntry.sending
                state.ops[i].ackDeadline = nil
                state.ops[i].nextAttemptAt = nil
                sentEdits[op.messageId] = i
            } else {
                state.ops[i].state = OutboxEntry.sending
                state.ops[i].ackDeadline = now + ackTimeoutMs
                state.ops[i].nextAttemptAt = nil
                effects.append(.schedule(at: now + ackTimeoutMs, event: opTimeoutEvent(state.ops[i])))
            }
        }
        // A newer sent edit supersedes the older unconfirmed one of the same message.
        if !sentEdits.isEmpty {
            state.ops = state.ops.enumerated().filter { i, op in
                guard op.op == DeliveryOp.edit, op.state == OutboxEntry.sending, let newest = sentEdits[op.messageId] else { return true }
                return newest == i
            }.map(\.element)
        }

        for i in eligibleHeads(state, now, wake) {
            if state.sendLog.count >= sendRateMax {
                wake(state.sendLog[0] + sendRateWindowMs)
                continue
            }
            state.outbox[i].state = OutboxEntry.sending
            state.outbox[i].transport = OutboxEntry.ws
            state.outbox[i].attempts += 1
            state.outbox[i].maybeStored = true
            state.outbox[i].ackDeadline = now + ackTimeoutMs
            state.outbox[i].nextAttemptAt = nil
            state.sendLog.append(now)
            effects.append(.sendWs(frame: sendMessageFrame(state.outbox[i])))
            effects.append(.schedule(at: now + ackTimeoutMs, event: ackTimeoutEvent(state.outbox[i])))
        }
        if let wakeAt, wakeAt != state.wakeAt { effects.append(.schedule(at: wakeAt, event: ["type": "tick"])) }
        state.wakeAt = wakeAt
    }

    private static func backgroundFlush(_ state: inout DeliveryState, _ now: Int64, _ effects: inout [DeliveryEffect]) {
        guard state.connection == DeliveryState.offline else { return }
        for i in eligibleHeads(state, now, { _ in }) {
            state.outbox[i].state = OutboxEntry.sending
            state.outbox[i].transport = OutboxEntry.http
            state.outbox[i].attempts += 1
            state.outbox[i].maybeStored = true
            state.outbox[i].ackDeadline = now + httpAckTimeoutMs
            state.outbox[i].nextAttemptAt = nil
            let e = state.outbox[i]
            let c = parseConversation(e.conversation)
            effects.append(.sendHttp(
                clientMsgId: e.clientMsgId,
                attempt: e.attempts,
                method: "POST",
                path: "/api/messages/\(c.conversationType == "channel" ? "channels" : "direct")/\(c.targetId)",
                body: [
                    "text": .string(e.text),
                    "type": .string(e.msgType),
                    "reply_to_id": .orNull(e.replyToId),
                    "metadata": e.metadata ?? .null,
                    "client_msg_id": .string(e.clientMsgId),
                ]
            ))
            effects.append(.schedule(at: now + httpAckTimeoutMs, event: ackTimeoutEvent(e)))
        }
    }

    // MARK: - Sync results

    private static func completeChain(_ state: inout DeliveryState, _ effects: inout [DeliveryEffect]) {
        state.sync.running = false
        effects.append(.refreshConversationLists)
        let visible = state.visible
        if state.sync.bootstrap, let visible { effects.append(.loadHistory(conversation: visible)) }

        // Cancelled entries that are not in flight (§7.10): this chain started after their last attempt.
        let unresolved = state.outbox.filter { $0.pendingDelete && $0.state != OutboxEntry.sending }
        if !state.sync.bootstrap {
            for e in unresolved {
                removeEntry(&state, e.clientMsgId)
                rememberCancelled(&state, e.clientMsgId)
            }
        } else {
            var seen = Set<String>()
            if let visible { seen.insert(visible) }
            for e in unresolved where !seen.contains(e.conversation) {
                seen.insert(e.conversation)
                effects.append(.loadHistory(conversation: e.conversation))
            }
        }
        state.sync.bootstrap = false
        if let visible, state.connection == DeliveryState.online { effects.append(.sendWs(frame: markReadFrame(visible))) }
    }

    private static func onSyncPage(_ state: inout DeliveryState, _ ev: JSONObject, _ effects: inout [DeliveryEffect]) {
        guard currentChain(state, ev), let body = ev["body"]?.object else { return }
        for rec in body["messages"]?.array ?? [] {
            if let rec = rec.object { ingest(&state, rec, "sync", &effects) }
        }
        let next = body["next_cursor"]?.string
        state.sync.cursor = next
        if body["has_more"]?.isTruthy ?? false {
            effects.append(.syncRequest(cursor: next, limit: syncPageLimit, chain: state.sync.chain))
            return
        }
        completeChain(&state, &effects)
    }

    // MARK: - User actions (§6.3, §7.10)

    private static func onEnqueue(_ state: inout DeliveryState, _ ev: JSONObject, _ effects: inout [DeliveryEffect]) {
        guard let cmid = ev["client_msg_id"]?.string, isValidClientMsgId(cmid) else {
            effects.append(.userError(code: "INVALID_CLIENT_MSG_ID"))
            return
        }
        if cmidInUse(state, cmid) { return }
        guard let conversation = ev["conversation"]?.string, isValidConversation(conversation) else {
            effects.append(.userError(code: "INVALID_CONVERSATION"))
            return
        }
        let typeValue = ev["msgType"]
        let msgType = (typeValue == nil || typeValue == .null) ? "text" : typeValue?.string
        guard let msgType, msgTypes.contains(msgType) else {
            effects.append(.userError(code: "INVALID_MESSAGE_TYPE"))
            return
        }
        if let error = textError(ev["text"], msgType) {
            effects.append(.userError(code: error))
            return
        }

        state.seq += 1
        state.outbox.append(OutboxEntry(
            clientMsgId: cmid,
            conversation: conversation,
            seq: state.seq,
            text: ev["text"]?.string ?? "",
            msgType: msgType,
            replyToId: ev["reply_to_id"]?.int64,
            metadata: ev["metadata"].flatMap { $0.isNull ? nil : $0 }
        ))
        effects.append(.clearComposer(conversation: conversation))
    }

    private static func onEdit(_ state: inout DeliveryState, _ ev: JSONObject, _ effects: inout [DeliveryEffect]) {
        let hasCmid = !(ev["client_msg_id"]?.isNull ?? true)
        let hasId = !(ev["message_id"]?.isNull ?? true)
        if hasCmid == hasId {
            effects.append(.userError(code: "NOT_EDITABLE"))
            return
        }

        if hasCmid {
            guard let i = entryIndex(state, ev["client_msg_id"]?.string),
                  !state.outbox[i].pendingDelete, state.outbox[i].msgType == "text" else {
                effects.append(.userError(code: "NOT_EDITABLE"))
                return
            }
            if let error = textError(ev["text"], "text") {
                effects.append(.userError(code: error))
                return
            }
            let text = ev["text"]?.string ?? ""
            if state.outbox[i].maybeStored {
                state.outbox[i].pendingEdit = text
            } else {
                state.outbox[i].text = text
            }
            return
        }

        guard let found = findMessage(state, ev["message_id"]?.int64),
              let m = state.messages[found.conv]?[found.index],
              m.senderId == state.me, m.isDeleted == 0, m.type == "text", deleteOpIndex(state, m.id) == nil else {
            effects.append(.userError(code: "NOT_EDITABLE"))
            return
        }
        if let error = textError(ev["text"], "text") {
            effects.append(.userError(code: error))
            return
        }
        state.ops.append(DeliveryOp(op: DeliveryOp.edit, messageId: m.id, text: ev["text"]?.string))
    }

    private static func onDelete(_ state: inout DeliveryState, _ ev: JSONObject, _ effects: inout [DeliveryEffect]) {
        guard let found = findMessage(state, ev["message_id"]?.int64),
              let m = state.messages[found.conv]?[found.index],
              m.senderId == state.me, m.isDeleted == 0 else {
            effects.append(.userError(code: "NOT_DELETABLE"))
            return
        }
        addDeleteOp(&state, m.id)
    }

    private static func onCancel(_ state: inout DeliveryState, _ ev: JSONObject, _ effects: inout [DeliveryEffect]) {
        guard let i = entryIndex(state, ev["client_msg_id"]?.string) else { return }
        if !state.outbox[i].maybeStored {
            state.outbox.remove(at: i)
            return
        }
        state.outbox[i].pendingDelete = true
        state.outbox[i].pendingEdit = nil
        addCancelOp(&state, state.outbox[i].clientMsgId)
        if state.outbox[i].state == OutboxEntry.failed {
            state.outbox[i].state = OutboxEntry.queued
            state.outbox[i].failure = nil
            state.outbox[i].failures = 0
            state.outbox[i].nextAttemptAt = nil
        }
        if state.outbox[i].state != OutboxEntry.sending { maybeStartSync(&state, &effects) }
    }

    private static func onRetry(_ state: inout DeliveryState, _ ev: JSONObject, _ effects: inout [DeliveryEffect]) {
        guard let i = entryIndex(state, ev["client_msg_id"]?.string), state.outbox[i].state == OutboxEntry.failed else { return }
        if let code = state.outbox[i].failure?.code, keyErrors.contains(code) {
            guard let fresh = ev["new_client_msg_id"]?.string, isValidClientMsgId(fresh), !cmidInUse(state, fresh) else {
                effects.append(.userError(code: "INVALID_CLIENT_MSG_ID"))
                return
            }
            state.outbox[i].clientMsgId = fresh
            state.outbox[i].maybeStored = false
        }
        state.outbox[i].state = OutboxEntry.queued
        state.outbox[i].failures = 0
        state.outbox[i].failure = nil
        state.outbox[i].nextAttemptAt = nil
        state.seq += 1
        state.outbox[i].seq = state.seq
        // Stable, as Array.prototype.sort.
        state.outbox = state.outbox.enumerated()
            .sorted { $0.element.seq != $1.element.seq ? $0.element.seq < $1.element.seq : $0.offset < $1.offset }
            .map(\.element)
    }

    // MARK: - Server frames

    /// error frames (§6.3, §7.12). New signals are recognized by their fields; frames of an older
    /// server (no retryable, no messageId) take the old paths.
    private static func onError(_ state: inout DeliveryState, _ frame: JSONObject, _ now: Int64, _ effects: inout [DeliveryEffect]) {
        let rateLimited = frame["code"]?.string == "RATE_LIMITED"
        let retryAfter: Int64
        if let raw = frame["retry_after_ms"]?.int64, raw > 0 {
            retryAfter = min(raw, rateLimitedMaxRetryMs)
        } else {
            retryAfter = rateLimitedRetryMs
        }
        let retryable = frame["retryable"] == .bool(true)
        let messageId = frame["messageId"]?.int64
        switch frame["context"]?.string {
        case "send_message":
            if frame["client_msg_id"]?.isNull ?? true { return }
            guard let i = entryIndex(state, frame["client_msg_id"]?.string), state.outbox[i].state != OutboxEntry.failed else { return }
            if rateLimited || retryable {
                // Not a refusal: the frame was dropped or failed before storage. Only the live WS attempt.
                guard state.outbox[i].state == OutboxEntry.sending, state.outbox[i].transport == OutboxEntry.ws else { return }
                if rateLimited {
                    attemptRateLimited(&state, i, now, retryAfter, &effects)
                } else {
                    attemptFailed(&state, i, now, &effects)
                }
                return
            }
            reject(&state, i, frame["code"]?.string, frame["message"]?.string)
        case "delete_message":
            guard let messageId, let i = deleteOpIndex(state, messageId), state.ops[i].state == OutboxEntry.sending else { return }
            if rateLimited {
                state.ops[i].state = OutboxEntry.queued
                state.ops[i].ackDeadline = nil
                state.ops[i].nextAttemptAt = now + retryAfter
            } else if retryable {
                opFailed(&state, i, now, &effects)
            } else {
                state.ops.remove(at: i)
                effects.append(.userError(code: "DELETE_REJECTED"))
            }
        case "edit_message":
            guard let messageId else { return }
            // Only the last sent edit of the message is matched; an older one was already superseded.
            var own: Int?
            if let sent = sentEditIndex(state, messageId), state.ops[sent].text == frame["text"]?.string { own = sent }
            if rateLimited {
                // Dropped unprocessed: send it again after the pause, unless a newer edit or a delete is
                // pending. A stale edit (no match) is never re-queued — it would revert the newer one.
                guard let own else { return }
                let newer = state.ops.contains { o in
                    o.messageId == messageId && (o.op == DeliveryOp.delete || (o.op == DeliveryOp.edit && o.state == OutboxEntry.queued))
                }
                if newer {
                    state.ops.remove(at: own)
                    return
                }
                state.ops[own].state = OutboxEntry.queued
                state.ops[own].nextAttemptAt = now + retryAfter
                return
            }
            if let own { state.ops.remove(at: own) }
            effects.append(.userError(code: "EDIT_REJECTED"))
        case "cancel_message":
            guard let cmid = frame["client_msg_id"]?.string,
                  let i = cancelOpIndex(state, cmid), state.ops[i].state == OutboxEntry.sending else { return }
            if rateLimited {
                state.ops[i].state = OutboxEntry.queued
                state.ops[i].ackDeadline = nil
                state.ops[i].nextAttemptAt = now + retryAfter
            } else if retryable {
                opFailed(&state, i, now, &effects)
            } else {
                state.ops.remove(at: i)
                if let messageId {
                    // Stored and cannot be deleted any more: stop hiding it, tell the user, show it again.
                    let entry = entryIndex(state, cmid).map { state.outbox[$0] }
                    forgetCancelled(&state, cmid)
                    if let del = deleteOpIndex(state, messageId) { state.ops.remove(at: del) }
                    if let entry, entry.pendingDelete {
                        removeEntry(&state, entry.clientMsgId)
                        effects.append(.loadHistory(conversation: entry.conversation))
                    }
                    effects.append(.userError(code: "DELETE_REJECTED"))
                }
            }
        default:
            return
        }
    }

    /// message_cancelled (§7.10): the server will never store this key; a stored copy is deleted.
    private static func onCancelled(_ state: inout DeliveryState, _ frame: JSONObject) {
        guard let cmid = frame["client_msg_id"]?.string else { return }
        if let i = cancelOpIndex(state, cmid) { state.ops.remove(at: i) }
        forgetCancelled(&state, cmid)
        if let i = entryIndex(state, cmid), state.outbox[i].pendingDelete { state.outbox.remove(at: i) }
        if let messageId = frame["messageId"]?.int64 { confirmDeleted(&state, messageId) }
    }

    private static func onFrame(_ state: inout DeliveryState, _ frame: JSONObject, _ effects: inout [DeliveryEffect], _ now: Int64) {
        switch frame["type"]?.string {
        case "auth_success":
            state.me = frame["user"]?["id"]?.int64
            state.connection = DeliveryState.online
            state.sendLog = []
            state.opsLog = []
            if !state.sync.running { startSync(&state, &effects) }
        case "new_message", "direct_message", "channel_message":
            if let message = frame["message"]?.object { ingest(&state, message, "live", &effects) }
        case "message_updated":
            if let message = frame["message"]?.object { ingest(&state, message, "update", &effects) }
        case "message_deleted":
            let messageId = frame["messageId"]?.int64
            if let found = findMessage(state, messageId) {
                state.messages[found.conv]?[found.index].isDeleted = 1
                state.messages[found.conv]?[found.index].text = ""
                state.messages[found.conv]?[found.index].metadataJson = nil
                if let updatedAt = frame["updated_at"], !updatedAt.isNull {
                    state.messages[found.conv]?[found.index].updatedAt = updatedAt.string
                }
            }
            // Without an integer id nothing is confirmed: the pending cancels of unsent messages
            // (their ops carry no message id) stay (parity with Android).
            if let messageId { confirmDeleted(&state, messageId) }
        case "message_cancelled":
            onCancelled(&state, frame)
        case "message_status_updated":
            guard let found = findMessage(state, frame["messageId"]?.int64), found.conv.hasPrefix("direct:"),
                  let m = state.messages[found.conv]?[found.index], m.senderId == state.me,
                  let status = frame["status"]?.string, (statusRank[status] ?? 0) >= 2 else { return }
            state.messages[found.conv]?[found.index].status = maxStatus(m.status, status)
        case "messages_read":
            let conv = "direct:\(raw(frame["byUserId"]))"
            guard var list = state.messages[conv] else { return }
            for id in frame["messageIds"]?.array ?? [] {
                guard let id = id.int64, let index = list.firstIndex(where: { $0.id == id }), list[index].senderId == state.me else { continue }
                list[index].status = "read"
            }
            state.messages[conv] = list
        case "error":
            onError(&state, frame, now, &effects)
        default:
            return
        }
    }

    private static func onHttpSendResult(_ state: inout DeliveryState, _ ev: JSONObject, _ now: Int64, _ effects: inout [DeliveryEffect]) {
        let status = ev["status"]?.int64
        if status == 200 || status == 201 {
            if let body = ev["body"]?.object { ingest(&state, body, "http", &effects) }
            return
        }
        guard let i = entryIndex(state, ev["client_msg_id"]?.string),
              state.outbox[i].state == OutboxEntry.sending, state.outbox[i].transport == OutboxEntry.http,
              state.outbox[i].attempts == ev["attempt"]?.int64 else { return }
        let s = status ?? 0
        if s == 401 {
            attemptInterrupted(&state.outbox[i])
        } else if s >= 400 && s < 500 && s != 408 && s != 429 {
            let body = ev["body"]?.object
            reject(&state, i, body?["code"]?.string, body?["error"]?.string)
        } else {
            attemptFailed(&state, i, now, &effects)
        }
    }

    /// A delete/cancel op attempt failed (timeout or a retryable error): pause or give up (§7.3, §7.10).
    /// A cancel op gives up silently: an older server ignores cancel_message, the sync path decides.
    private static func opFailed(_ state: inout DeliveryState, _ i: Int, _ now: Int64, _ effects: inout [DeliveryEffect]) {
        state.ops[i].failures += 1
        state.ops[i].ackDeadline = nil
        if state.ops[i].failures >= maxAttempts {
            let op = state.ops.remove(at: i)
            if op.op == DeliveryOp.delete { effects.append(.userError(code: "DELETE_NOT_CONFIRMED")) }
        } else {
            state.ops[i].state = OutboxEntry.queued
            state.ops[i].nextAttemptAt = now + backoff(state.ops[i].failures)
        }
    }

    private static func onOpTimeout(_ state: inout DeliveryState, _ ev: JSONObject, _ now: Int64, _ effects: inout [DeliveryEffect]) {
        let cmid = ev["client_msg_id"]
        let index = (cmid != nil && cmid != .null) ? cancelOpIndex(state, cmid?.string) : deleteOpIndex(state, ev["message_id"]?.int64)
        guard let i = index, state.ops[i].state == OutboxEntry.sending, state.ops[i].attempts == ev["attempt"]?.int64,
              now >= (state.ops[i].ackDeadline ?? 0) else { return }
        opFailed(&state, i, now, &effects)
    }

    /// unread_snapshot counts, completed with live messages newer than the snapshot (§7.8, G7):
    /// last_message_ids[k] is the newest id the server saw when it computed counts[k].
    private static func snapshotTotals(_ state: DeliveryState, _ ev: JSONObject) -> [(String, Int64)] {
        let lastIds = ev["last_message_ids"]?.object ?? [:]
        var totals: [(String, Int64)] = []
        for (k, n) in ev["counts"]?.object ?? [:] {
            let count = n.int64 ?? 0
            guard let last = lastIds[k] else {
                totals.append((k, count))
                continue
            }
            let list = state.messages[k] ?? []
            var base = count
            var from = last.int64 ?? 0
            if k.hasPrefix("channel:") {
                // An own channel message newer than the snapshot read the channel up to it (§7.8).
                let ownNewer = list.filter { $0.senderId == state.me && $0.id > from }
                if let newest = ownNewer.map(\.id).max() {
                    base = 0
                    from = newest
                }
            }
            // A tombstone has nothing to read: deleted foreign messages newer than the snapshot are not added.
            totals.append((k, base + Int64(list.filter { $0.senderId != state.me && $0.id > from && $0.isDeleted == 0 }.count)))
        }
        return totals
    }

    private static func resetInFlight(_ state: inout DeliveryState, http: Bool) {
        for i in state.outbox.indices where state.outbox[i].state == OutboxEntry.sending && (http || state.outbox[i].transport == OutboxEntry.ws) {
            attemptInterrupted(&state.outbox[i])
        }
        // An unconfirmed sent edit is not resent after a disconnect or restart (§7.10): dropped.
        state.ops.removeAll { $0.op == DeliveryOp.edit && $0.state == OutboxEntry.sending }
        for i in state.ops.indices where state.ops[i].state == OutboxEntry.sending {
            state.ops[i].state = OutboxEntry.queued
            state.ops[i].ackDeadline = nil
            state.ops[i].nextAttemptAt = nil
        }
    }

    // MARK: - Reducer

    private static func handle(_ state: inout DeliveryState, _ ev: JSONObject, _ now: Int64, _ effects: inout [DeliveryEffect]) {
        switch ev["type"]?.string {
        case "ws":
            if let frame = ev["frame"]?.object { onFrame(&state, frame, &effects, now) }
        case "ws_disconnected":
            state.connection = DeliveryState.offline
            state.sync.running = false
            state.sendLog = []
            state.opsLog = []
            resetInFlight(&state, http: false)
        case "enqueue": onEnqueue(&state, ev, &effects)
        case "edit": onEdit(&state, ev, &effects)
        case "delete": onDelete(&state, ev, &effects)
        case "cancel": onCancel(&state, ev, &effects)
        case "retry": onRetry(&state, ev, &effects)
        case "ack_timeout":
            if let i = entryIndex(state, ev["client_msg_id"]?.string), state.outbox[i].state == OutboxEntry.sending,
               state.outbox[i].attempts == ev["attempt"]?.int64, now >= (state.outbox[i].ackDeadline ?? 0) {
                attemptFailed(&state, i, now, &effects)
            }
        case "op_timeout": onOpTimeout(&state, ev, now, &effects)
        case "tick": break
        case "sync_start": maybeStartSync(&state, &effects)
        case "sync_page": onSyncPage(&state, ev, &effects)
        case "sync_reset_410":
            guard currentChain(state, ev) else { return }
            state.sync.cursor = nil
            state.sync.bootstrap = true
            state.messages = [:]
            effects.append(.syncRequest(cursor: nil, limit: syncPageLimit, chain: state.sync.chain))
        case "sync_failed":
            guard currentChain(state, ev) else { return }
            state.sync.running = false
            if ev["status"]?.int64 != 401 {
                let retryAfter = ev["retry_after_ms"].flatMap { $0.isNull ? nil : $0.int64 } ?? syncRetryMs
                effects.append(.schedule(at: now + retryAfter, event: ["type": "sync_start"]))
            }
        case "history_page":
            for rec in ev["body"]?.array ?? [] {
                if let rec = rec.object { ingest(&state, rec, "history", &effects) }
            }
        case "http_send_result": onHttpSendResult(&state, ev, now, &effects)
        case "unread_snapshot":
            let totals = snapshotTotals(state, ev)
            state.unread = [:]
            for (k, n) in totals where n > 0 && k != state.visible { state.unread[k] = n }
            if let visible = state.visible, (totals.first { $0.0 == visible }?.1 ?? 0) > 0, state.connection == DeliveryState.online {
                effects.append(.sendWs(frame: markReadFrame(visible)))
            }
        case "conversation_opened":
            guard let conversation = ev["conversation"]?.string else { return }
            state.visible = conversation
            state.unread[conversation] = nil
            if state.connection == DeliveryState.online { effects.append(.sendWs(frame: markReadFrame(conversation))) }
        case "conversation_closed":
            state.visible = nil
        case "background_flush":
            backgroundFlush(&state, now, &effects)
        case "app_restart":
            state.connection = DeliveryState.offline
            state.visible = nil
            state.sync.running = false
            state.sync.bootstrap = false
            state.messages = [:]
            state.unread = [:]
            state.sendLog = []
            state.opsLog = []
            state.wakeAt = nil
            resetInFlight(&state, http: true)
        default:
            return
        }
    }
}

/// `Date.parse` of the ISO-8601 forms the server writes (`2026-10-02T09:00:01.000Z`, with or
/// without fraction or offset, `T` or a space); epoch milliseconds, nil when unreadable.
enum ISOInstant {
    static func milliseconds(_ text: String) -> Double? {
        let chars = Array(text.trimmingCharacters(in: .whitespaces).utf8)
        var i = 0
        func number(_ count: Int) -> Int? {
            guard i + count <= chars.count else { return nil }
            var value = 0
            for k in 0..<count {
                let c = chars[i + k]
                guard c >= 48, c <= 57 else { return nil }
                value = value * 10 + Int(c - 48)
            }
            i += count
            return value
        }
        func expect(_ c: UInt8) -> Bool {
            guard i < chars.count, chars[i] == c else { return false }
            i += 1
            return true
        }
        guard let year = number(4), expect(45), let month = number(2), expect(45), let day = number(2) else { return nil }
        guard i < chars.count, chars[i] == 84 || chars[i] == 32 else { return nil } // T or space
        i += 1
        guard let hour = number(2), expect(58), let minute = number(2) else { return nil }
        var second = 0
        var millis = 0.0
        if expect(58) {
            guard let s = number(2) else { return nil }
            second = s
            if expect(46) {
                var fraction = 0.0
                var scale = 100.0
                var digits = 0
                while i < chars.count, chars[i] >= 48, chars[i] <= 57 {
                    fraction += Double(chars[i] - 48) * scale
                    scale /= 10
                    digits += 1
                    i += 1
                }
                guard digits > 0 else { return nil }
                millis = (fraction).rounded(.towardZero)
            }
        }
        var offsetMinutes = 0
        if i < chars.count {
            if chars[i] == 90 { // Z
                i += 1
            } else if chars[i] == 43 || chars[i] == 45 { // + -
                let sign = chars[i] == 43 ? 1 : -1
                i += 1
                guard let oh = number(2) else { return nil }
                _ = expect(58)
                guard let om = number(2) else { return nil }
                offsetMinutes = sign * (oh * 60 + om)
            }
        }
        guard i == chars.count, (1...12).contains(month), (1...31).contains(day), hour < 24, minute < 60, second < 61 else { return nil }
        let days = daysFromCivil(year: year, month: month, day: day)
        let seconds = Double(days) * 86_400 + Double(hour * 3_600 + minute * 60 + second) - Double(offsetMinutes * 60)
        return seconds * 1_000 + millis
    }

    /// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's algorithm).
    private static func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }
}
