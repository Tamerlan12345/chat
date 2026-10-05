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
    }

    public func add(_ item: RecentItem) {}

    public func clear() {}
}
