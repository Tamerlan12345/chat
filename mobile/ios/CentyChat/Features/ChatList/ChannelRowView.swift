import SwiftUI

/// A channel in the inbox: the slate `#` tile (a lock for a private channel) and the same three type
/// steps as a dialog row.
public struct ChannelRowView: View {
    public let channel: Channel
    var typing: String?
    var zoom: Namespace.ID?

    public init(channel: Channel) {
        self.channel = channel
    }

    init(channel: Channel, typing: String?, zoom: Namespace.ID?) {
        self.channel = channel
        self.typing = typing
        self.zoom = zoom
    }

    public var body: some View {
        InboxRowLayout(
            name: channel.name,
            preview: channel.lastMessageText ?? channel.topic ?? String(localized: "Канал"),
            time: channel.lastMessageTime,
            unread: channel.unreadCount,
            typing: typing
        ) {
            let tile = ChannelAvatar(isPrivate: channel.type == .private, size: 44)
            if let zoom {
                tile.chatZoomSource(type: .channel, id: channel.id, namespace: zoom)
            } else {
                tile
            }
        }
    }
}

#Preview("Channel rows") {
    List {
        ChannelRowView(channel: Channel(id: 10, name: "mobile-dev", topic: "Разработка", unreadCount: 5, lastMessageText: "Сборка зелёная", lastMessageTime: Date()))
        ChannelRowView(channel: Channel(id: 11, name: "общий", type: .private, lastMessageText: "Совещание в 15:00", lastMessageTime: Date().addingTimeInterval(-7_200)))
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(CentyColors.list)
}
