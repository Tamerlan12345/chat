import Foundation
import Observation

/// A channel in the results and the matched parts of its name.
public struct ChannelMatch: Equatable, Sendable, Identifiable {
    public var channel: Channel
    public var highlights: [Range<Int>]
    public var id: Int64 { channel.id }
}

/// A message found on the server: where it leads, who wrote it and the snippet with the match.
public struct MessageHit: Equatable, Sendable, Identifiable {
    public var message: Message
    public var conversationType: ConversationType
    /// The colleague of a direct dialog or the channel id.
    public var targetId: Int64
    /// Colleague or channel name: the title of the chat it opens.
    public var conversationTitle: String
    public var senderName: String
    public var isOwn: Bool
    public var snippet: String
    public var highlights: [Range<Int>]

    public var id: Int64 { message.id }

    /// The chat opened at this message.
    public var route: ChatRoute {
        ChatRoute(type: conversationType, targetId: targetId, title: conversationTitle, highlightMessageId: message.id)
    }
}

public enum MessageResults: Equatable, Sendable {
    /// Shorter than two characters: the server is not asked.
    case idle
    case loading
    case found([MessageHit])
    case failed(rateLimited: Bool)

    public var hits: [MessageHit]? {
        if case .found(let hits) = self { return hits }
        return nil
    }
}

/// What Return opens: the first result in section order.
public enum SearchTarget: Equatable, Sendable {
    case person(Int64)
    case channel(Int64)
    case message(Int64)
}

public struct UniversalSearchState: Equatable, Sendable {
    public var query = ""
    public var recents: [RecentItem] = []
    public var people: [PersonMatch] = []
    /// How many people match in total («Все сотрудники (N)»).
    public var peopleTotal = 0
    public var channels: [ChannelMatch] = []
    public var messages = MessageResults.idle

    public var isEmptyQuery: Bool { query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    public var nothingFound: Bool {
        !isEmptyQuery && people.isEmpty && channels.isEmpty && messages.hits?.isEmpty == true
    }
}

/// The search in «Чаты» (spec «Universal search»): people and channels locally on every keystroke,
/// messages from the server 300 ms after the last keystroke and only from two characters. A new
/// query cancels the previous one; a late answer for an old query is never shown. Port of
/// `UniversalSearchViewModel` (Android).
@Observable
@MainActor
public final class UniversalSearchModel {
    public static let minServerQuery = 2
    public static let maxPeople = 5
    public static let maxChannels = 4
    public static let maxMessages = 20

    public private(set) var query = ""

    @ObservationIgnored private let directory: any PeopleProviding
    @ObservationIgnored private let channels: @MainActor () -> [Channel]
    @ObservationIgnored private let searchMessages: @MainActor (String) async throws -> [Message]
    @ObservationIgnored private let recents: SearchRecentsStore
    @ObservationIgnored private let requests: PeopleRequests
    @ObservationIgnored private let currentUserId: @MainActor () -> Int64?
    @ObservationIgnored private let debounce: Duration

    public init(
        directory: any PeopleProviding,
        channels: @escaping @MainActor () -> [Channel],
        searchMessages: @escaping @MainActor (String) async throws -> [Message],
        recents: SearchRecentsStore,
        requests: PeopleRequests,
        currentUserId: @escaping @MainActor () -> Int64?,
        debounce: Duration = .milliseconds(300)
    ) {
        self.directory = directory
        self.channels = channels
        self.searchMessages = searchMessages
        self.recents = recents
        self.requests = requests
        self.currentUserId = currentUserId
        self.debounce = debounce
    }

    public var state: UniversalSearchState {
        UniversalSearchState(query: query)
    }

    public var firstResult: SearchTarget? { nil }

    public func setQuery(_ value: String) {
        query = value
    }

    public func clear() {
        setQuery("")
    }

    /// The search opened: the directory refreshes if it is stale.
    public func opened() {}

    /// «Все сотрудники (N)»: the «Сотрудники» tab opens with the same query.
    public func showAllPeople() {}

    public func rememberPerson(_ person: Person) {}

    public func rememberChannel(_ channel: Channel) {}

    public func remember(_ item: RecentItem) {}
}

/// The message text for two result lines: starts a little before the first match (with «…») so the
/// match is visible, with every query word highlighted.
public enum Snippet {
    public static func of(_ text: String, query: String) -> (String, [Range<Int>]) {
        (text, [])
    }
}
