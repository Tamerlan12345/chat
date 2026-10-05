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
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        var state = UniversalSearchState(query: query, recents: recents.items)
        guard !trimmed.isEmpty else { return state }
        let ranked = PeopleSearch.rank(directory.state.people, query: trimmed)
        state.people = Array(ranked.prefix(Self.maxPeople))
        state.peopleTotal = ranked.count
        state.channels = Array(Self.matchChannels(channels(), query: trimmed).prefix(Self.maxChannels))
        state.messages = messages
        return state
    }

    /// What Return opens: the first person, else the first channel, else the first message.
    public var firstResult: SearchTarget? {
        let state = self.state
        guard !state.isEmptyQuery else { return nil }
        if let person = state.people.first { return .person(person.person.id) }
        if let channel = state.channels.first { return .channel(channel.channel.id) }
        if let hit = state.messages.hits?.first { return .message(hit.message.id) }
        return nil
    }

    private var messages = MessageResults.idle
    /// The trimmed query the message search currently works on (or last finished).
    @ObservationIgnored private var scheduled: String?
    @ObservationIgnored private var searchTask: Task<Void, Never>?

    public func setQuery(_ value: String) {
        query = value
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        // A trailing space does not change the search: the results stay, no endless skeleton.
        guard trimmed != scheduled else { return }
        scheduled = trimmed
        searchTask?.cancel()
        guard trimmed.count >= Self.minServerQuery else {
            messages = .idle
            searchTask = nil
            return
        }
        // At once, not after the pause: the skeleton appears together with the local results.
        messages = .loading
        let pause = debounce
        let search = searchMessages
        searchTask = Task { [weak self] in
            do {
                try await Task.sleep(for: pause)
            } catch {
                return
            }
            let result: MessageResults
            do {
                let found = try await search(trimmed)
                guard let self else { return }
                result = .found(found.prefix(Self.maxMessages).map { self.hit($0, query: trimmed) })
            } catch {
                result = .failed(rateLimited: Self.isRateLimited(error))
            }
            // A new keystroke cancelled this search: its late answer is not shown.
            guard !Task.isCancelled, let self, self.scheduled == trimmed else { return }
            self.messages = result
        }
    }

    public func clear() {
        setQuery("")
    }

    /// The search opened: the directory refreshes (cache first, then the server).
    public func opened() {
        directory.refresh()
    }

    /// «Все сотрудники (N)»: the «Сотрудники» tab opens with the same query.
    public func showAllPeople() {
        requests.send(.search(query.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    public func rememberPerson(_ person: Person) {
        recents.add(RecentItem(kind: .person, targetId: person.id, title: person.fullName, avatarUrl: person.avatarUrl))
    }

    public func rememberChannel(_ channel: Channel) {
        recents.add(RecentItem(kind: .channel, targetId: channel.id, title: channel.name))
    }

    public func remember(_ item: RecentItem) {
        recents.add(item)
    }

    // MARK: - Results

    /// Channels whose name holds every query word («#» optional); names starting with the query first.
    static func matchChannels(_ list: [Channel], query: String) -> [ChannelMatch] {
        let tokens = SearchText.tokens(query.hasPrefix("#") ? String(query.dropFirst()) : query)
        guard !tokens.isEmpty else { return [] }
        let matches: [ChannelMatch] = list.compactMap { channel in
            let name = SearchText.normalizedCharacters(channel.name)
            var ranges: [Range<Int>] = []
            for token in tokens {
                guard let at = characterIndex(of: Array(token), in: name) else { return nil }
                ranges.append(at..<(at + token.count))
            }
            return ChannelMatch(channel: channel, highlights: ranges.sorted { $0.lowerBound < $1.lowerBound })
        }
        return matches.sorted { a, b in
            let aStarts = Self.startsName(a)
            let bStarts = Self.startsName(b)
            if aStarts != bStarts { return aStarts }
            return NameOrder.precedes(a.channel.name, b.channel.name)
        }
    }

    /// The match is at the start of the name, ignoring a leading «#».
    private static func startsName(_ match: ChannelMatch) -> Bool {
        guard let first = match.highlights.first?.lowerBound else { return false }
        return first == 0 || (first == 1 && match.channel.name.hasPrefix("#"))
    }

    private func hit(_ message: Message, query: String) -> MessageHit {
        let me = currentUserId()
        let isOwn = message.senderId == me
        let people = directory.state.people
        let targetId: Int64
        let title: String
        switch message.conversationType {
        case .channel:
            targetId = message.targetId
            title = channels().first(where: { $0.id == message.targetId })?.name ?? ""
        case .direct:
            let partner = isOwn ? message.targetId : message.senderId
            targetId = partner
            title = people.first(where: { $0.id == partner })?.fullName ?? (isOwn ? "" : message.senderName)
        }
        let sender: String
        if message.senderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            sender = people.first(where: { $0.id == message.senderId })?.fullName ?? ""
        } else {
            sender = message.senderName
        }
        let (snippet, highlights) = Snippet.of(message.text, query: query)
        return MessageHit(
            message: message,
            conversationType: message.conversationType,
            targetId: targetId,
            conversationTitle: title,
            senderName: sender,
            isOwn: isOwn,
            snippet: snippet,
            highlights: highlights
        )
    }

    private static func isRateLimited(_ error: any Error) -> Bool {
        if case APIError.httpError(let statusCode, _, _, _) = error { return statusCode == 429 }
        return false
    }
}

/// The message text for two result lines: starts a little before the first match (with «…») so the
/// match is visible, with every query word highlighted. Offsets are characters.
public enum Snippet {
    private static let lead = 32

    public static func of(_ text: String, query: String) -> (String, [Range<Int>]) {
        let flat = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let tokens = SearchText.tokens(query)
        let characters = Array(flat)
        let normalized = SearchText.normalizedCharacters(flat)
        let first = tokens.compactMap { characterIndex(of: Array($0), in: normalized) }.min() ?? 0
        var start = 0
        if first > lead {
            // Start at a word boundary a little before the match when there is one.
            let window = (first - lead)...(first - lead / 2)
            if let space = window.reversed().first(where: { characters[$0] == " " }) {
                start = space + 1
            } else {
                start = first - lead / 2
            }
        }
        let snippet = (start > 0 ? "…" : "") + String(characters[start...])
        let folded = SearchText.normalizedCharacters(snippet)
        var ranges: [Range<Int>] = []
        for token in tokens {
            let needle = Array(token)
            var from = 0
            while let at = characterIndex(of: needle, in: folded, from: from) {
                ranges.append(at..<(at + needle.count))
                from = at + needle.count
            }
        }
        return (snippet, ranges.sorted { $0.lowerBound < $1.lowerBound })
    }
}

/// When a found message was written, for the result row.
public enum SearchHitTime {
    public static func text(for date: Date, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }
}
