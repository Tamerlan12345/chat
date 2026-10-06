import SwiftUI

/// Главный экран с вкладками после успешной авторизации: Чаты, Сотрудники, Объявления, Профиль.
/// Каждая вкладка держит свой стек и своё состояние (прокрутку, поиск).
///
/// Badges count conversations with unread messages and announcements awaiting acknowledgement; the
/// tab the user is on carries none (anti-generated polish rule 6). The tab bar is the L0 plane:
/// the system bar material, content scrolls under it.
public struct MainTabView: View {
    @Environment(ConversationsStore.self) private var conversations
    @Environment(AnnouncementsStore.self) private var announcements

    @State private var navigation = AppNavigation()
    @State private var peopleRequests = PeopleRequests()

    private var unreadConversations: Int {
        conversations.unreadDirectConversations + conversations.unreadChannelConversations
    }

    public init() {}

    public var body: some View {
        TabView(selection: $navigation.selectedTab) {
            ChatListView()
                .tabItem {
                    Label("Чаты", systemImage: "bubble.left.and.bubble.right")
                }
                .badge(TabBadge.text(unreadConversations, isSelected: navigation.selectedTab == .chats).map { Text($0) })
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
                .badge(TabBadge.text(announcements.unconfirmedCount, isSelected: navigation.selectedTab == .announcements).map { Text($0) })
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

#if DEBUG
#Preview("Tabs") {
    MainTabView()
        .previewEnvironment()
}
#endif
