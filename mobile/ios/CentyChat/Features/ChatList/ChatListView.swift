import SwiftUI

public enum ChatListTab: Int, CaseIterable {
    case direct = 0
    case channels = 1
    
    var title: String {
        switch self {
        case .direct: return "Личные"
        case .channels: return "Каналы"
        }
    }
}

/// Экран списка диалогов и корпоративных каналов
public struct ChatListView: View {
    @Environment(AppState.self) private var appState
    
    @State private var selectedTab: ChatListTab = .direct
    @State private var searchText: String = ""
    @State private var showNewChatSheet: Bool = false
    @State private var showNewChannelSheet: Bool = false
    
    public init() {}
    
    private var totalDirectUnread: Int {
        appState.directConversations.reduce(0) { $0 + $1.unreadCount }
    }
    
    private var totalChannelUnread: Int {
        appState.channels.reduce(0) { $0 + $1.unreadCount }
    }
    
    private var filteredConversations: [DirectConversation] {
        if searchText.isEmpty {
            return appState.directConversations
        }
        return appState.directConversations.filter {
            $0.fullName.localizedCaseInsensitiveContains(searchText) ||
            ($0.departmentName?.localizedCaseInsensitiveContains(searchText) ?? false) ||
            ($0.lastMessageText?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }
    
    private var filteredChannels: [Channel] {
        if searchText.isEmpty {
            return appState.channels
        }
        return appState.channels.filter {
            $0.name.localizedCaseInsensitiveContains(searchText) ||
            ($0.topic?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }
    
    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Переключатель вкладок Личные / Каналы
                Picker("Категория", selection: $selectedTab) {
                    HStack {
                        Text("Личные")
                        if totalDirectUnread > 0 {
                            Text("(\(totalDirectUnread))")
                        }
                    }
                    .tag(ChatListTab.direct)
                    
                    HStack {
                        Text("Каналы")
                        if totalChannelUnread > 0 {
                            Text("(\(totalChannelUnread))")
                        }
                    }
                    .tag(ChatListTab.channels)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 8)
                .background(Color(uiColor: .systemBackground))
                
                // Списки бесед
                if selectedTab == .direct {
                    directConversationsList
                } else {
                    channelsList
                }
            }
            .navigationTitle("Чаты")
            .searchable(text: $searchText, prompt: "Поиск по переписке и сотрудникам")
            .refreshable {
                await appState.loadAllData()
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: {
                        if selectedTab == .direct {
                            showNewChatSheet = true
                        } else {
                            showNewChannelSheet = true
                        }
                    }) {
                        Image(systemName: selectedTab == .direct ? "square.and.pencil" : "plus.bubble.fill")
                    }
                }
            }
            .sheet(isPresented: $showNewChatSheet) {
                newDirectChatSheet
            }
            .sheet(isPresented: $showNewChannelSheet) {
                newChannelSheet
            }
        }
    }
    
    // MARK: - Direct List
    
    private var directConversationsList: some View {
        List {
            if filteredConversations.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "Нет активных диалогов" : "Ничего не найдено",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text(searchText.isEmpty ? "Нажмите карандаш сверху, чтобы начать диалог с коллегой" : "Попробуйте изменить поисковый запрос")
                )
                .listRowBackground(Color.clear)
            } else {
                ForEach(filteredConversations) { conv in
                    NavigationLink(destination: ChatDetailView(
                        conversationType: .direct,
                        targetId: conv.userId,
                        title: conv.fullName,
                        avatarUrl: conv.avatarUrl,
                        status: conv.status
                    )) {
                        ConversationRowView(conversation: conv)
                    }
                }
            }
        }
        .listStyle(.plain)
    }
    
    // MARK: - Channels List
    
    private var channelsList: some View {
        List {
            if filteredChannels.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "Нет доступных каналов" : "Ничего не найдено",
                    systemImage: "number",
                    description: Text("Создайте новый канал для координации")
                )
                .listRowBackground(Color.clear)
            } else {
                ForEach(filteredChannels) { channel in
                    NavigationLink(destination: ChatDetailView(
                        conversationType: .channel,
                        targetId: channel.id,
                        title: channel.name,
                        avatarUrl: nil,
                        status: nil
                    )) {
                        ChannelRowView(channel: channel)
                    }
                }
            }
        }
        .listStyle(.plain)
    }
    
    // MARK: - New Direct Chat Sheet (Colleagues Directory)
    
    private var newDirectChatSheet: some View {
        NavigationStack {
            List(appState.users) { colleague in
                Button(action: {
                    showNewChatSheet = false
                }) {
                    NavigationLink(destination: ChatDetailView(
                        conversationType: .direct,
                        targetId: colleague.id,
                        title: colleague.fullName,
                        avatarUrl: colleague.avatarUrl,
                        status: colleague.status
                    )) {
                        HStack(spacing: 12) {
                            AvatarView(name: colleague.fullName, avatarUrl: colleague.avatarUrl, status: colleague.status, size: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(colleague.fullName)
                                    .font(.headline)
                                Text(colleague.jobTitle ?? colleague.departmentName ?? "")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Новый диалог")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Отмена") { showNewChatSheet = false }
                }
            }
        }
    }
    
    // MARK: - New Channel Sheet
    
    @State private var newChannelName: String = ""
    @State private var newChannelTopic: String = ""
    @State private var isPrivateChannel: Bool = false
    @State private var isCreatingChannel: Bool = false
    
    private var newChannelSheet: some View {
        NavigationStack {
            Form {
                Section(header: Text("Параметры канала")) {
                    TextField("Название (например: #Проект)", text: $newChannelName)
                    TextField("Тема (необязательно)", text: $newChannelTopic)
                    Toggle("Приватный канал", isOn: $isPrivateChannel)
                }
                
                Section {
                    Button(action: {
                        Task { await createChannelAction() }
                    }) {
                        if isCreatingChannel {
                            ProgressView()
                        } else {
                            Text("Создать канал")
                                .frame(maxWidth: .infinity)
                                .foregroundColor(newChannelName.isEmpty ? .secondary : CentyColors.primaryBlue)
                        }
                    }
                    .disabled(newChannelName.isEmpty || isCreatingChannel)
                }
            }
            .navigationTitle("Новый канал")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Отмена") { showNewChannelSheet = false }
                }
            }
        }
    }
    
    private func createChannelAction() async {
        isCreatingChannel = true
        defer { isCreatingChannel = false }
        
        let type: ChannelType = isPrivateChannel ? .private : .public
        var name = newChannelName.trimmingCharacters(in: .whitespaces)
        if !name.hasPrefix("#") {
            name = "#" + name
        }
        
        do {
            let created = try await APIClient.shared.createChannel(
                name: name,
                topic: newChannelTopic.isEmpty ? nil : newChannelTopic,
                type: type
            )
            appState.channels.insert(created, at: 0)
            showNewChannelSheet = false
            newChannelName = ""
            newChannelTopic = ""
            CentyHaptics.success()
        } catch {
            print("[ChatListView] Error creating channel: \(error)")
            CentyHaptics.error()
        }
    }
}
