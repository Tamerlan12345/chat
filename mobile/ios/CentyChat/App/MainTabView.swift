import SwiftUI

/// Главный экран с вкладками после успешной авторизации
public struct MainTabView: View {
    @Environment(AppState.self) private var appState
    
    private var totalChatUnread: Int {
        let direct = appState.directConversations.reduce(0) { $0 + $1.unreadCount }
        let channels = appState.channels.reduce(0) { $0 + $1.unreadCount }
        return direct + channels
    }
    
    private var unconfirmedAnnouncementsCount: Int {
        appState.announcements.filter { !$0.isConfirmed }.count
    }
    
    public init() {}
    
    public var body: some View {
        TabView {
            // Вкладка 1: Чаты
            ChatListView()
                .tabItem {
                    Label("Чаты", systemImage: "bubble.left.and.bubble.right.fill")
                }
                .badge(totalChatUnread > 0 ? "\(totalChatUnread)" : nil)
            
            // Вкладка 2: Корпоративные распоряжения
            AnnouncementsView()
                .tabItem {
                    Label("Распоряжения", systemImage: "megaphone.fill")
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
