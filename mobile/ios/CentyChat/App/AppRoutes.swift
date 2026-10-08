import SwiftUI

extension View {
    /// The screens any tab's stack can push: a chat and a person card. `zoom` is the namespace of
    /// the rows whose avatar the pushed screen zooms out of (iOS 18+: inbox row → chat, person row →
    /// card; a plain push before that and a crossfade-like push with Reduce Motion).
    func appRoutes(zoom: Namespace.ID) -> some View {
        navigationDestination(for: AppRoute.self) { route in
            switch route {
            case .chat(let chat):
                RoutedChat(route: chat)
                    .modifier(ZoomFromRow(key: ZoomKey.chat(chat.type, chat.targetId), namespace: zoom, enabled: chat.zoomsFromRow))
            case .person(let person):
                PersonCardView(route: person)
                    .modifier(ZoomFromRow(key: ZoomKey.person(person.id), namespace: zoom, enabled: person.zoomsFromRow))
            }
        }
    }

    /// Marks this view (a row's avatar) as the source the person card zooms out of.
    func personZoomSource(id: Int64, namespace: Namespace.ID) -> some View {
        modifier(ZoomSource(key: ZoomKey.person(id), namespace: namespace))
    }

    /// Marks this view (an inbox row's avatar) as the source the chat zooms out of.
    func chatZoomSource(type: ConversationType, id: Int64, namespace: Namespace.ID) -> some View {
        modifier(ZoomSource(key: ZoomKey.chat(type, id), namespace: namespace))
    }
}

/// A pushed chat: full screen without the tab bar on iPhone; in a regular-width layout (iPad split
/// view) the tab bar stays, as nothing else would bring it back.
private struct RoutedChat: View {
    let route: ChatRoute
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        ChatDetailView(
            conversationType: route.type,
            targetId: route.targetId,
            title: route.title,
            avatarUrl: route.avatarUrl,
            status: route.status,
            highlightMessageId: route.highlightMessageId,
            hidesTabBar: sizeClass != .regular
        )
    }
}

enum ZoomKey {
    static func person(_ id: Int64) -> String { "person-avatar-\(id)" }
    static func chat(_ type: ConversationType, _ id: Int64) -> String { "chat-\(type.rawValue)-\(id)" }
}

private struct ZoomFromRow: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let key: String
    let namespace: Namespace.ID
    let enabled: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            if enabled && !reduceMotion {
                content.navigationTransition(.zoom(sourceID: key, in: namespace))
            } else {
                content
            }
        } else {
            content
        }
    }
}

private struct ZoomSource: ViewModifier {
    let key: String
    let namespace: Namespace.ID

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.matchedTransitionSource(id: key, in: namespace)
        } else {
            content
        }
    }
}
