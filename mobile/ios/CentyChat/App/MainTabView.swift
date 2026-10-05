import SwiftUI

/// Главный экран с вкладками после успешной авторизации: Чаты, Сотрудники, Объявления, Профиль.
/// Каждая вкладка держит свой стек и своё состояние (прокрутку, поиск).
public struct MainTabView: View {
    @Environment(ConversationsStore.self) private var conversations
    @Environment(AnnouncementsStore.self) private var announcements

    @State private var navigation = AppNavigation()
    @State private var peopleRequests = PeopleRequests()

    private var totalChatUnread: Int {
        conversations.totalDirectUnread + conversations.totalChannelUnread
    }

    private var unconfirmedAnnouncementsCount: Int {
        announcements.unconfirmedCount
    }

    public init() {}

    public var body: some View {
        TabView(selection: $navigation.selectedTab) {
            ChatListView()
                .tabItem {
                    Label("Чаты", systemImage: "bubble.left.and.bubble.right")
                }
                .badge(totalChatUnread > 0 ? "\(totalChatUnread)" : nil)
                .tag(AppTab.chats)

            PeopleView()
                .tabItem {
                    Label("Сотрудники", systemImage: "person.2")
                }
                .tag(AppTab.people)

            AnnouncementsView()
                .tabItem {
                    Label("Объявления", systemImage: "megaphone")
                }
                .badge(unconfirmedAnnouncementsCount > 0 ? "\(unconfirmedAnnouncementsCount)" : nil)
                .tag(AppTab.announcements)

            ProfileView()
                .tabItem {
                    Label("Профиль", systemImage: "person.crop.circle")
                }
                .tag(AppTab.profile)
        }
        .tint(CentyColors.primaryBlue)
        .environment(navigation)
        .environment(peopleRequests)
        // «Все сотрудники (N)» from the search, «Отдел» from a card: show «Сотрудники».
        .onChange(of: peopleRequests.serial) {
            navigation.selectedTab = .people
        }
    }
}
