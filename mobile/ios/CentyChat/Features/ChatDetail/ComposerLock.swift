import Foundation

/// Why the composer of a direct chat is closed.
enum ComposerLock: Equatable, Sendable {
    case none
    /// I blocked this person: nothing goes either way until I unblock.
    case blockedByMe
    /// The server refused a send with `DM_NOT_ALLOWED` (the other side blocked me).
    case notDeliverable

    static func of(blockedByMe: Bool, refused: Bool) -> ComposerLock {
        .none
    }
}

/// The server's `DM_NOT_ALLOWED` in one direct chat.
struct RefusedDelivery: Sendable {
    let conversation: String
    let peer: Int64
    private(set) var closed = false

    init(conversation: String, peer: Int64) {
        self.conversation = conversation
        self.peer = peer
    }

    mutating func observe(outbox: [OutboxEntry], shown: [Message]) {}

    mutating func reopen(outbox: [OutboxEntry]?) {}
}

/// Which messages of a conversation are shown.
enum ChatVisibility {
    static func messages(_ messages: [Message], in type: ConversationType, isBlocked: (Int64) -> Bool) -> [Message] {
        messages.filter { !isBlocked($0.senderId) }
    }
}
