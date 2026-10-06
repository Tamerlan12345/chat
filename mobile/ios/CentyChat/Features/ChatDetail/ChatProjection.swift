import Foundation

/// What the chat shows (`delivery-state.md` §3.4): the conversation's messages by id without those
/// the user is deleting (a `delete` op hides them until the tombstone), then its outbox entries by
/// `seq` without cancelled ones (text `pending_edit ?? text`), then files still going up. A row keeps
/// its identity across confirmation: `client_msg_id` when there is one.
@MainActor
final class ChatProjection {
    private let conversationType: ConversationType
    private let targetId: Int64
    private let key: String
    /// Decoded server records, reused while the model's message is unchanged.
    private var decoded: [Int64: (msg: Msg, message: Message)] = [:]

    init(conversationType: ConversationType, targetId: Int64) {
        self.conversationType = conversationType
        self.targetId = targetId
        key = "\(conversationType.rawValue):\(targetId)"
    }

    func build(
        state: DeliveryState,
        me: Int64,
        myName: String,
        uploads: [AttachmentUploads.Item],
        handedOver: [String: PendingUpload],
        fileURL: (String) -> URL
    ) -> [Message] {
        // Only the signed-in account's model is shown: another account's leftovers never, and a model
        // that names no account yet holds nothing to show.
        guard state.me == me else { return [] }
        let deleting = Set(state.ops.filter { $0.op == DeliveryOp.delete }.compactMap(\.messageId))
        var keys = Set<String>()
        var result: [Message] = []
        var alive = Set<Int64>()
        for msg in state.messages[key] ?? [] {
            alive.insert(msg.id)
            if deleting.contains(msg.id) { continue }
            if let clientMsgId = msg.clientMsgId { keys.insert(clientMsgId) }
            result.append(decode(msg, me: me))
        }
        decoded = decoded.filter { alive.contains($0.key) }
        for entry in state.outbox where entry.conversation == key && !entry.pendingDelete {
            keys.insert(entry.clientMsgId)
            result.append(local(entry, me: me, myName: myName, upload: handedOver[entry.clientMsgId], fileURL: fileURL))
        }
        for item in uploads where item.pending.conversation == key && item.pending.owner == me && !keys.contains(item.pending.clientMsgId) {
            result.append(uploading(item, me: me, myName: myName, fileURL: fileURL))
        }
        return withReplies(result)
    }

    private func decode(_ msg: Msg, me: Int64) -> Message {
        if let cached = decoded[msg.id], cached.msg == msg { return cached.message }
        let record = msg.mergedRecord
        var message = (try? JSONDecoder().decode(Message.self, from: JSONValue.object(record).jsonData)) ?? Message(
            id: msg.id,
            conversationType: conversationType,
            targetId: targetId,
            senderId: msg.senderId,
            text: msg.text,
            senderName: String(localized: "Пользователь")
        )
        let deleted = msg.isDeleted == 1
        message.text = msg.text
        message.isDeleted = deleted
        message.clientMsgId = msg.clientMsgId
        message.replyToId = msg.replyToId
        if deleted {
            message.metadata = nil
            message.metadataJson = nil
            message.fileOriginalName = nil
        }
        message.deliveryStatus = msg.senderId == me ? DeliveryStatus(rawValue: msg.status ?? "sent") ?? .sent : nil
        message.sendState = nil
        decoded[msg.id] = (msg, message)
        return message
    }

    private func local(_ entry: OutboxEntry, me: Int64, myName: String, upload: PendingUpload?, fileURL: (String) -> URL) -> Message {
        var message = Message(
            id: Self.localId(entry.clientMsgId),
            conversationType: conversationType,
            targetId: targetId,
            senderId: me,
            text: entry.pendingEdit ?? entry.text,
            type: MessageType(rawValue: entry.msgType) ?? .text,
            replyToId: entry.replyToId,
            metadataJson: entry.metadata?.jsonText,
            createdAt: LocalSendTimes.firstSeen(entry.clientMsgId),
            senderName: myName,
            clientMsgId: entry.clientMsgId,
            sendState: Self.sendState(of: entry)
        )
        message.pendingMetadata = entry.metadata
        message.fileOriginalName = entry.msgType == "text" ? nil : entry.text
        if entry.state == OutboxEntry.failed { message.failureReason = Self.failureText(entry.failure) }
        if let upload {
            message.localUpload = LocalUpload(fileURL: fileURL(upload.localPath), name: upload.name, size: upload.size, mimeType: upload.mimeType, progress: nil)
            message.fileWidth = upload.width
            message.fileHeight = upload.height
        }
        return message
    }

    private func uploading(_ item: AttachmentUploads.Item, me: Int64, myName: String, fileURL: (String) -> URL) -> Message {
        let pending = item.pending
        var message = Message(
            id: Self.localId(pending.clientMsgId),
            conversationType: conversationType,
            targetId: targetId,
            senderId: me,
            text: pending.name,
            type: AttachmentRules.isImage(name: pending.name, mimeType: pending.mimeType) ? .image : .file,
            replyToId: pending.replyToId,
            createdAt: Date(timeIntervalSince1970: TimeInterval(pending.createdAt) / 1_000),
            senderName: myName,
            fileOriginalName: pending.name,
            clientMsgId: pending.clientMsgId,
            sendState: pending.failed ? .failed : (item.progress != nil ? .sending : .queued)
        )
        message.failureReason = pending.error
        message.fileWidth = pending.width
        message.fileHeight = pending.height
        message.localUpload = LocalUpload(fileURL: fileURL(pending.localPath), name: pending.name, size: pending.size, mimeType: pending.mimeType, progress: item.progress)
        return message
    }

    /// A reply shows its quote (desktop ChatView: the original found among the loaded messages).
    private func withReplies(_ messages: [Message]) -> [Message] {
        guard messages.contains(where: { $0.replyToId != nil }) else { return messages }
        var byId: [Int64: Message] = [:]
        for message in messages { byId[message.id] = message }
        return messages.map { message in
            guard let replyTo = message.replyToId, !message.isDeleted,
                  let original = byId[replyTo], !original.isDeleted else { return message }
            var quoted = message
            let text = original.text.trimmingCharacters(in: .whitespacesAndNewlines)
            quoted.replyQuote = ReplyQuote(senderName: original.senderName, text: text.isEmpty ? String(localized: "Вложение") : text)
            return quoted
        }
    }

    static func sendState(of entry: OutboxEntry) -> SendState {
        switch entry.state {
        case OutboxEntry.sending: return .sending
        case OutboxEntry.failed: return .failed
        default: return .queued
        }
    }

    /// Why a message was not sent: the server's own words when it refused; otherwise ours.
    static func failureText(_ failure: DeliveryFailure?) -> String {
        if let message = failure?.message?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty {
            return message
        }
        if failure?.reason == DeliveryFailure.maxAttempts {
            return String(localized: "Сервер не ответил")
        }
        return String(localized: "Сервер не принял сообщение")
    }

    /// A stable negative id for a message the server has not numbered yet (FNV-1a of the key).
    static func localId(_ clientMsgId: String) -> Int64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in clientMsgId.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return -Int64(hash & 0x3fff_ffff_ffff_ffff) - 1
    }
}

/// What the composer holds once a message was stored: empty, unless the user typed on meanwhile.
enum ComposerText {
    static func afterSend(sent: String, current: String) -> String {
        current == sent ? "" : current
    }
}

/// When this device first showed each unsent message (the outbox keeps no time): the bubble's time
/// until the server's record replaces it.
@MainActor
enum LocalSendTimes {
    private static var times: [String: Date] = [:]

    static func firstSeen(_ clientMsgId: String) -> Date {
        if let time = times[clientMsgId] { return time }
        let now = Date()
        times[clientMsgId] = now
        return now
    }

    /// Sign-out: the times of the account's unsent messages go with them.
    static func removeAll() {
        times.removeAll()
    }
}

/// How far a message has come, for its mark: queued < sending < failed (settled, needs the user) <
/// sent < delivered < read.
enum DeliveryMark: Int, Comparable, Sendable {
    case queued = 0
    case sending = 1
    case failed = 2
    case sent = 3
    case delivered = 4
    case read = 5

    static func < (lhs: DeliveryMark, rhs: DeliveryMark) -> Bool { lhs.rawValue < rhs.rawValue }

    init(_ message: Message) {
        switch message.sendState {
        case .queued: self = .queued
        case .sending: self = .sending
        case .failed: self = .failed
        case nil:
            switch message.deliveryStatus {
            case .read: self = .read
            case .delivered: self = .delivered
            default: self = .sent
            }
        }
    }
}

/// One bubble of the list with its place in a group (one sender, one day, at most 5 minutes apart).
struct ChatRow: Identifiable, Equatable {
    var id: String { message.rowID }
    let message: Message
    /// First bubble of a day: a date separator goes before it.
    let startsDay: Bool
    let startsGroup: Bool
    let endsGroup: Bool
    /// Time and state are shown on the last bubble of a group; an earlier bubble shows them when it
    /// is edited, or when it is queued/sending while its group ends further along — a stalled earlier
    /// message is never hidden behind a later one. Stable inputs only: a delivery status catching up
    /// never reflows history.
    let showsMeta: Bool
}

enum ChatTimeline {
    /// Desktop ChatView: a new group after 5 minutes, another sender or another day.
    static let groupBreak: TimeInterval = 5 * 60

    static func rows(_ messages: [Message], me: Int64?, timeZone: TimeZone = .current) -> [ChatRow] {
        guard !messages.isEmpty else { return [] }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let days = messages.map { calendar.startOfDay(for: $0.createdAt) }
        let starts = messages.indices.map { i in
            i == 0 || days[i] != days[i - 1] || messages[i].senderId != messages[i - 1].senderId
                || messages[i].createdAt.timeIntervalSince(messages[i - 1].createdAt) > groupBreak
        }
        let marks = messages.map(DeliveryMark.init)
        var groupEnd = Array(repeating: 0, count: messages.count)
        for i in messages.indices.reversed() {
            groupEnd[i] = i == messages.count - 1 || starts[i + 1] ? i : groupEnd[i + 1]
        }
        return messages.indices.map { i in
            let message = messages[i]
            let ends = groupEnd[i] == i
            let edited = message.updatedAt != nil && !message.isDeleted
            let mark = marks[i]
            let stalled = (mark == .queued || mark == .sending) && marks[groupEnd[i]] > mark
            return ChatRow(
                message: message,
                startsDay: i == 0 || days[i] != days[i - 1],
                startsGroup: starts[i],
                endsGroup: ends,
                showsMeta: ends || edited || stalled
            )
        }
    }
}
