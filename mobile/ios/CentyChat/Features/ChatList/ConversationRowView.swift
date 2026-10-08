import SwiftUI

/// A dialog in the inbox (68 pt): avatar 44 with presence, three type steps only — the name in
/// `headline` `textStrong`, the preview in `subheadline` `textSecondary` (one line), the time in
/// `caption` `textDim`, tabular. An unread row lifts its preview to `textMain` at weight 600 next to
/// the pill. Typing replaces the preview with the wave and «печатает…» in the accent colour.
public struct ConversationRowView: View {
    public let conversation: DirectConversation
    var typing: String?
    var zoom: Namespace.ID?

    public init(conversation: DirectConversation) {
        self.conversation = conversation
    }

    init(conversation: DirectConversation, typing: String?, zoom: Namespace.ID?) {
        self.conversation = conversation
        self.typing = typing
        self.zoom = zoom
    }

    public var body: some View {
        InboxRowLayout(
            name: conversation.fullName,
            preview: conversation.lastMessageText ?? String(localized: "Нет сообщений"),
            time: conversation.lastMessageTime,
            unread: conversation.unreadCount,
            typing: typing
        ) {
            let avatar = AvatarView(
                name: conversation.fullName,
                avatarUrl: conversation.avatarUrl,
                status: conversation.status,
                size: 44,
                ringColor: CentyColors.list,
                isTyping: typing != nil
            )
            if let zoom {
                avatar.chatZoomSource(type: .direct, id: conversation.userId, namespace: zoom)
            } else {
                avatar
            }
        }
    }
}

/// The shared geometry of inbox rows (dialogs and channels).
struct InboxRowLayout<Avatar: View>: View {
    let name: String
    let preview: String
    let time: Date?
    let unread: Int
    var typing: String?
    @ViewBuilder let avatar: () -> Avatar

    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isUnread: Bool { unread > 0 }

    var body: some View {
        HStack(alignment: typeSize.isAccessibilitySize ? .top : .center, spacing: 12) {
            avatar()
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(name)
                        .font(.headline)
                        .foregroundStyle(CentyColors.textStrong)
                        .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                    Spacer(minLength: 4)
                    if let time {
                        Text(ChatDates.inboxTime(time))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(isUnread ? CentyColors.accentText : CentyColors.textDim)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                }
                HStack(alignment: .center, spacing: 8) {
                    if let typing {
                        TypingIndicatorView(text: typing)
                            .transition(.opacity)
                    } else {
                        Text(preview)
                            .font(.subheadline.weight(isUnread ? .semibold : .regular))
                            .foregroundStyle(isUnread ? CentyColors.textMain : CentyColors.textSecondary)
                            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                            .transition(.opacity)
                    }
                    Spacer(minLength: 0)
                    if isUnread {
                        UnreadPill(count: unread)
                    }
                }
                .animation(CentyMotion.or(CentyMotion.easeOut(), reduceMotion: reduceMotion), value: typing)
                .animation(CentyMotion.or(.spring(response: 0.3, dampingFraction: 0.8), reduceMotion: reduceMotion), value: isUnread)
            }
            // Hairline separators start at the text edge.
            .alignmentGuide(.listRowSeparatorLeading) { dimensions in dimensions[.leading] }
        }
        .padding(.vertical, 12)
        .frame(minHeight: 68)
        // No `.combine` here: the link (or button) around the row already reads it as one element,
        // and UI tests find the name as its own text.
        .contentShape(Rectangle())
    }
}

#Preview("Inbox rows") {
    List {
        ConversationRowView(conversation: DirectConversation(userId: 2, fullName: "Боб Тестов", status: .online, lastMessageText: "Привет, Алиса! Всё работает.", lastMessageTime: Date(), unreadCount: 2))
        ConversationRowView(conversation: DirectConversation(userId: 3, fullName: "Карина Смирнова", status: .away, lastMessageText: "Счёт отправила на почту", lastMessageTime: Date().addingTimeInterval(-86_400)), typing: "Карина печатает...", zoom: nil)
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(CentyColors.list)
}
