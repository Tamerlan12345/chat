import Foundation
import Observation

/// Someone or something opened from the search: a person or a channel.
public struct RecentItem: Codable, Equatable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case person
        case channel
    }

    public var kind: Kind
    public var targetId: Int64
    public var title: String
    public var avatarUrl: String?

    public init(kind: Kind, targetId: Int64, title: String, avatarUrl: String? = nil) {
        self.kind = kind
        self.targetId = targetId
        self.title = title
        self.avatarUrl = avatarUrl
    }

    public var id: String { "\(kind.rawValue)-\(targetId)" }
}

/// «Недавние» in the empty search: the last five people or channels opened. Local and not secret
/// (ids and names only); wiped when the session ends.
@Observable
@MainActor
public final class SearchRecentsStore {
    public static let limit = 5
    nonisolated static let key = "centychat.search.recents"

    public private(set) var items: [RecentItem] = []

    @ObservationIgnored private let defaults: UserDefaults?

    /// `defaults` nil keeps the list in memory only (tests, previews).
    public init(defaults: UserDefaults?) {
        self.defaults = defaults
        if let data = defaults?.data(forKey: Self.key),
           let stored = try? JSONDecoder().decode([RecentItem].self, from: data) {
            items = Array(stored.prefix(Self.limit))
        }
    }

    /// The newest first, without repeats, at most five.
    public func add(_ item: RecentItem) {
        items = Array(([item] + items.filter { $0.id != item.id }).prefix(Self.limit))
        if let data = try? JSONEncoder().encode(items) {
            defaults?.set(data, forKey: Self.key)
        }
    }

    public func clear() {
        items = []
        defaults?.removeObject(forKey: Self.key)
    }
}
