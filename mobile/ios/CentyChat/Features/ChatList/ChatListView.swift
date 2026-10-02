import SwiftUI

public enum ChatListTab: Int, CaseIterable {
    case direct = 0
    case channels = 1

    var title: String {
        switch self {
        case .direct: return String(localized: "Личные")
        case .channels: return String(localized: "Каналы")
        }
    }
}

/// Экран списка диалогов и корпоративных каналов
public struct ChatListView: View {
    @Environment(AppContainer.self) private var container
    @Environment(ConversationsStore.self) private var conversations

    @State private var selectedTab: ChatListTab = .direct
    @State private var searchText: String = ""
    @State private var showNewChatSheet: Bool = false
    @State private var showNewChannelSheet: Bool = false

    public init() {}

    private var totalDirectUnread: Int {
        conversations.totalDirectUnread
    }

    private var totalChannelUnread: Int {
        conversations.totalChannelUnread
    }

    private var directTabTitle: String {
        totalDirectUnread > 0 ? String(localized: "Личные (\(totalDirectUnread))") : String(localized: "Личные")
    }

    private var channelsTabTitle: String {
        totalChannelUnread > 0 ? String(localized: "Каналы (\(totalChannelUnread))") : String(localized: "Каналы")
    }

    private var filteredConversations: [DirectConversation] {
        if searchText.isEmpty {
            return conversations.directConversations
        }
        return conversations.directConversations.filter {
            $0.fullName.localizedCaseInsensitiveContains(searchText) ||
            ($0.departmentName?.localizedCaseInsensitiveContains(searchText) ?? false) ||
            ($0.lastMessageText?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    private var filteredChannels: [Channel] {
        if searchText.isEmpty {
            return conversations.channels
        }
        return conversations.channels.filter {
            $0.name.localizedCaseInsensitiveContains(searchText) ||
            ($0.topic?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Переключатель вкладок Личные / Каналы
                Picker("Раздел", selection: $selectedTab) {
                    Text(directTabTitle).tag(ChatListTab.direct)
                    Text(channelsTabTitle).tag(ChatListTab.channels)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(CentyColors.navigationSurface)

                // Списки бесед
                if selectedTab == .direct {
                    directConversationsList
                } else {
                    channelsList
                }
            }
            .navigationTitle("CentyChat")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $searchText, prompt: "Поиск по переписке и сотрудникам")
            .refreshable {
                await container.loadAllData()
            }
            .toolbarBackground(CentyColors.navigationSurface, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        Task { await container.loadAllData() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Обновить список")
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: {
                        if selectedTab == .direct {
                            showNewChatSheet = true
                        } else {
                            showNewChannelSheet = true
                        }
                    }) {
                        Image(systemName: selectedTab == .direct ? "square.and.pencil" : "plus")
                    }
                    .accessibilityLabel(selectedTab == .direct ? "Новый диалог" : "Новый канал")
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
                if searchText.isEmpty && ListLoadStateView.replacesEmptyState(conversations.directState) {
                    ListLoadStateView(state: conversations.directState, failureTitle: "Не удалось загрузить диалоги") {
                        await conversations.loadDirectConversations()
                    }
                    .listRowBackground(Color.clear)
                } else {
                    ContentUnavailableView(
                        searchText.isEmpty ? "Нет активных диалогов" : "Ничего не найдено",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text(searchText.isEmpty ? "Нажмите карандаш сверху, чтобы начать диалог с коллегой" : "Попробуйте изменить поисковый запрос")
                    )
                    .listRowBackground(Color.clear)
                }
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
                    .listRowBackground(CentyColors.cardBackground)
                    .listRowSeparatorTint(CentyColors.rowSeparator)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(CentyColors.chatBackground)
    }

    // MARK: - Channels List

    private var channelsList: some View {
        List {
            if filteredChannels.isEmpty {
                if searchText.isEmpty && ListLoadStateView.replacesEmptyState(conversations.channelsState) {
                    ListLoadStateView(state: conversations.channelsState, failureTitle: "Не удалось загрузить каналы") {
                        await conversations.loadChannels()
                    }
                    .listRowBackground(Color.clear)
                } else {
                    ContentUnavailableView(
                        searchText.isEmpty ? "Нет доступных каналов" : "Ничего не найдено",
                        systemImage: "number",
                        description: Text("Создайте новый канал для координации")
                    )
                    .listRowBackground(Color.clear)
                }
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
                    .listRowBackground(CentyColors.cardBackground)
                    .listRowSeparatorTint(CentyColors.rowSeparator)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(CentyColors.chatBackground)
    }

    // MARK: - New Direct Chat Sheet (Colleagues Directory)

    private var newDirectChatSheet: some View {
        NavigationStack {
            List(conversations.users) { colleague in
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

        do {
            try await conversations.createChannel(
                name: newChannelName,
                topic: newChannelTopic,
                isPrivate: isPrivateChannel
            )
            showNewChannelSheet = false
            newChannelName = ""
            newChannelTopic = ""
            CentyHaptics.success()
        } catch {
            Log.chat.error("Creating channel failed: \(error.localizedDescription, privacy: .public)")
            CentyHaptics.error()
        }
    }
}
