import Foundation

/// Why the composer of a direct chat is closed (`copy-ru.md` §4; Android `ComposerLock`).
enum ComposerLock: Equatable, Sendable {
    case unlocked
    /// I blocked this person: nothing goes either way until I unblock.
    case blockedByMe
    /// The server refused a send with `DM_NOT_ALLOWED` (the other side blocked me). By design the
    /// app does not say who blocked whom.
    case notDeliverable

    static func of(blockedByMe: Bool, refused: Bool) -> ComposerLock {
        if blockedByMe { return .blockedByMe }
        if refused { return .notDeliverable }
        return .unlocked
    }
}

/// The server's `DM_NOT_ALLOWED` in one direct chat (`conversation` with `peer`): a refused send
/// closes the composer (`closed`); seeing delivery work again — a fresh history load, an unblock, or
/// a newer message from the peer (they may have unblocked me) — reopens it. A send refused after
/// that closes it again. A port of Android's `RefusedDelivery` (parity P5).
struct RefusedDelivery: Sendable {
    static let code = "DM_NOT_ALLOWED"

    let conversation: String
    let peer: Int64
    private(set) var closed = false
    /// Refusals the chat no longer stays closed for: delivery was seen to work after them.
    private var reopenedAfter = Set<String>()
    /// The newest message from the peer seen so far.
    private var newestPeerMessage: Int64?

    init(conversation: String, peer: Int64) {
        self.conversation = conversation
        self.peer = peer
    }

    /// The model changed: `outbox` is the queue, `shown` this chat's projected history.
    mutating func observe(outbox: [OutboxEntry], shown: [Message]) {
        let peerNewest = shown.filter { $0.senderId == peer && $0.sendState == nil && $0.id > 0 }.map(\.id).max()
        if let peerNewest, let seen = newestPeerMessage, peerNewest > seen {
            reopen(outbox: outbox)
        }
        if let peerNewest, newestPeerMessage.map({ peerNewest > $0 }) ?? true {
            newestPeerMessage = peerNewest
        }
        if refusals(outbox).contains(where: { !reopenedAfter.contains($0) }) {
            closed = true
        }
    }

    /// Delivery works again (or I unblocked the peer): the refusals so far no longer close the chat.
    mutating func reopen(outbox: [OutboxEntry]?) {
        if let outbox { reopenedAfter.formUnion(refusals(outbox)) }
        closed = false
    }

    /// Client keys of this chat's sends the server refused with `DM_NOT_ALLOWED`.
    private func refusals(_ outbox: [OutboxEntry]) -> [String] {
        outbox
            .filter { $0.conversation == conversation && $0.state == OutboxEntry.failed && $0.failure?.code == Self.code }
            .map(\.clientMsgId)
    }
}

/// Which messages of a conversation are shown. A block hides the blocked person's direct messages
/// only; channels are not affected (`registration.md` §4, parity P6).
enum ChatVisibility {
    static func messages(_ messages: [Message], in type: ConversationType, isBlocked: (Int64) -> Bool) -> [Message] {
        guard type == .direct else { return messages }
        return messages.filter { !isBlocked($0.senderId) }
    }
}
