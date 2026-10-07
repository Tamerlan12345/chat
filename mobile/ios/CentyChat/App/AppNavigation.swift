import Foundation
import Observation

/// The four top-level destinations, in tab-bar order.
public enum AppTab: Hashable, Sendable {
    case chats
    case people
    case announcements
    case profile
}

/// Which tab is on screen; screens switch tabs through it («Все сотрудники», «Редактировать профиль»).
@Observable
@MainActor
public final class AppNavigation {
    public var selectedTab: AppTab = .chats

    public init() {}
}

/// One tab's navigation stack. Screens push onto the stack they are shown in, so «Написать» from
/// a card opens the chat in the current tab (back → card → list).
@Observable
@MainActor
public final class NavigationRouter {
    public var path: [AppRoute] = []

    public init() {}

    public func push(_ route: AppRoute) {
        path.append(route)
    }

    public func popToRoot() {
        path.removeAll()
    }

    /// «Написать» from a card: the chat pushes onto this stack — unless the card was opened from
    /// that very chat's header, then back is the chat (no second copy of it on the stack).
    public func open(chat: ChatRoute) {
        if path.count >= 2, case .chat(let below) = path[path.count - 2],
           below.type == chat.type, below.targetId == chat.targetId {
            path.removeLast()
        } else {
            push(.chat(chat))
        }
    }
}

/// The number on a tab (anti-generated polish rule 6): conversations, not messages; none on the
/// tab the user is on.
enum TabBadge {
    static func text(_ count: Int, isSelected: Bool) -> String? {
        guard count > 0, !isSelected else { return nil }
        return count > 99 ? "99+" : "\(count)"
    }
}

/// A chat to open, optionally at a message found by the search.
public struct ChatRoute: Hashable, Sendable {
    public var type: ConversationType
    public var targetId: Int64
    public var title: String
    public var avatarUrl: String?
    public var status: UserStatus?
    /// Scroll to this message and pulse it (a search hit).
    public var highlightMessageId: Int64?
    /// The inbox row's avatar is a zoom source for the push (iOS 18+).
    public var zoomsFromRow: Bool

    public init(
        type: ConversationType,
        targetId: Int64,
        title: String,
        avatarUrl: String? = nil,
        status: UserStatus? = nil,
        highlightMessageId: Int64? = nil,
        zoomsFromRow: Bool = false
    ) {
        self.type = type
        self.targetId = targetId
        self.title = title
        self.avatarUrl = avatarUrl
        self.status = status
        self.highlightMessageId = highlightMessageId
        self.zoomsFromRow = zoomsFromRow
    }

    public static func direct(with person: Person) -> ChatRoute {
        ChatRoute(type: .direct, targetId: person.id, title: person.fullName, avatarUrl: person.avatarUrl, status: person.status)
    }

    public static func channel(_ channel: Channel) -> ChatRoute {
        ChatRoute(type: .channel, targetId: channel.id, title: channel.name)
    }
}

/// A person card to open. Name and photo come from the row, so the header shows at once.
public struct PersonRoute: Hashable, Sendable {
    public var id: Int64
    public var name: String
    public var avatarUrl: String?
    /// The row's avatar is a zoom source for the push (iOS 18+).
    public var zoomsFromRow: Bool

    public init(id: Int64, name: String, avatarUrl: String? = nil, zoomsFromRow: Bool = false) {
        self.id = id
        self.name = name
        self.avatarUrl = avatarUrl
        self.zoomsFromRow = zoomsFromRow
    }
}

public enum AppRoute: Hashable, Sendable {
    case chat(ChatRoute)
    case person(PersonRoute)
}
