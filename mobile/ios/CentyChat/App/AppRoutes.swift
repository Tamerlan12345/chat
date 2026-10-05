import SwiftUI

extension View {
    /// The screens any tab's stack can push: a chat and a person card. `zoom` is the namespace of
    /// the rows whose avatar the card zooms out of (iOS 18+; a plain push before that and with
    /// Reduce Motion).
    func appRoutes(zoom: Namespace.ID) -> some View {
        navigationDestination(for: AppRoute.self) { route in
            switch route {
            case .chat(let chat):
                ChatDetailView(
                    conversationType: chat.type,
                    targetId: chat.targetId,
                    title: chat.title,
                    avatarUrl: chat.avatarUrl,
                    status: chat.status,
                    highlightMessageId: chat.highlightMessageId
                )
            case .person(let person):
                PersonCardView(route: person)
                    .modifier(ZoomFromRow(id: person.id, namespace: zoom, enabled: person.zoomsFromRow))
            }
        }
    }

    /// Marks this view (a row's avatar) as the source the person card zooms out of.
    func personZoomSource(id: Int64, namespace: Namespace.ID) -> some View {
        modifier(PersonZoomSource(id: id, namespace: namespace))
    }
}

private struct ZoomFromRow: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let id: Int64
    let namespace: Namespace.ID
    let enabled: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            if enabled && !reduceMotion {
                content.navigationTransition(.zoom(sourceID: PersonZoomSource.key(id), in: namespace))
            } else {
                content
            }
        } else {
            content
        }
    }
}

private struct PersonZoomSource: ViewModifier {
    let id: Int64
    let namespace: Namespace.ID

    static func key(_ id: Int64) -> String { "person-avatar-\(id)" }

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.matchedTransitionSource(id: Self.key(id), in: namespace)
        } else {
            content
        }
    }
}
