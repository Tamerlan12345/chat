import SwiftUI

/// Главный экран с вкладками после успешной авторизации
public struct MainTabView: View {
    @Environment(ConversationsStore.self) private var conversations
    @Environment(AnnouncementsStore.self) private var announcements

    private var totalChatUnread: Int {
        conversations.totalDirectUnread + conversations.totalChannelUnread
    }

    private var unconfirmedAnnouncementsCount: Int {
        announcements.unconfirmedCount
    }

    public init() {}

    public var body: some View {
        TabView {
            // Вкладка 1: Чаты
            ChatListView()
                .tabItem {
                    Label("Сообщения", systemImage: "bubble.left.and.bubble.right.fill")
                }
                .badge(totalChatUnread > 0 ? "\(totalChatUnread)" : nil)

            // Вкладка 2: Корпоративные распоряжения
            AnnouncementsView()
                .tabItem {
                    Label("Объявления", systemImage: "megaphone.fill")
                }
                .badge(unconfirmedAnnouncementsCount > 0 ? "\(unconfirmedAnnouncementsCount)" : nil)

            // Вкладка 3: Профиль сотрудника
            ProfileView()
                .tabItem {
                    Label("Профиль", systemImage: "person.crop.circle.fill")
                }
        }
        .tint(CentyColors.primaryBlue)
    }
}
