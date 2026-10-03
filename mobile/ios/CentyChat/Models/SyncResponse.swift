import Foundation

/// Дельта синхронизации (GET /api/sync). `next_cursor` — непрозрачная строка.
public struct SyncResponse: Codable, Sendable {
    public let messages: [Message]
    public let nextCursor: String
    public let hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case messages
        case nextCursor = "next_cursor"
        case hasMore = "has_more"
    }
}
