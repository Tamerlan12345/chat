import Foundation

/// Jumping to a found message: the history around it, continuous up to the newest message, so
/// realtime messages continue it without a hole. `beforeId = id + 1` brings the message itself and
/// `olderCount` earlier ones; newer ones come in `afterId` pages. When more than
/// `pageSize × maxPages` are newer, there is no window (nil): the chat opens at its newest messages.
/// Port of `HistoryWindow` (Android).
@MainActor
enum HistoryWindow {
    static let olderCount = 30
    static let pageSize = 200
    static let maxPages = 5

    static func around(
        _ messageId: Int64,
        before: (_ beforeId: Int64, _ limit: Int) async throws -> [Message],
        after: (_ afterId: Int64, _ limit: Int) async throws -> [Message]
    ) async throws -> [Message]? {
        let older = try await before(messageId + 1, olderCount + 1)
        guard older.contains(where: { $0.id == messageId }) else { return nil }
        var newer: [Message] = []
        var cursor = messageId
        for _ in 0..<maxPages {
            let page = try await after(cursor, pageSize)
            newer += page
            if page.count < pageSize {
                var seen = Set<Int64>()
                return (older + newer)
                    .filter { seen.insert($0.id).inserted }
                    .sorted { $0.id < $1.id }
            }
            cursor = page.map(\.id).max() ?? cursor
        }
        return nil
    }
}
