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

/// Экран списка диалогов и корпоративных каналов. Поиск — общий («Люди · Каналы · Сообщения»),
/// со своим экраном результатов, а не фильтр поверх списка.
public struct ChatListView: View {
    @Environment(AppContainer.self) private var container
    @Environment(ConversationsStore.self) private var conversations
    @Environment(PeopleRequests.self) private var peopleRequests

    @State private var selectedTab: ChatListTab = .direct
    @State private var showNewChatSheet: Bool = false
    @State private var showNewChannelSheet: Bool = false
    @State private var router = NavigationRouter()
    @State private var search: UniversalSearchModel?
    @State private var isSearchPresented = false
    @Namespace private var zoom

    public init() {}

    /// The results replace the inbox while the field is focused or holds text.
    private var isSearchActive: Bool {
        isSearchPresented || !(search?.query.isEmpty ?? true)
    }

    private var searchQuery: Binding<String> {
        Binding(get: { search?.query ?? "" }, set: { search?.setQuery($0) })
    }

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

    public var body: some View {
        NavigationStack(path: $router.path) {
            Group {
                if isSearchActive, let search {
                    UniversalSearchResultsView(model: search, zoom: zoom, open: openSelection)
                } else {
                    inbox
                }
            }
            .navigationTitle("Чаты")
            .navigationBarTitleDisplayMode(.large)
            .searchable(
                text: searchQuery,
                isPresented: $isSearchPresented,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Люди, каналы, сообщения"
            )
            // Return opens the first result.
            .onSubmit(of: .search) { openFirstResult() }
            .onChange(of: isSearchPresented) { _, presented in
                if presented { search?.opened() }
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
            .appRoutes(zoom: zoom)
        }
        .environment(router)
        .onAppear {
            guard search == nil else { return }
            let conversations = self.conversations
            search = UniversalSearchModel(
                directory: container.people,
                channels: { conversations.channels },
                searchMessages: { query in try await conversations.searchMessages(query) },
                recents: container.searchRecents,
                requests: peopleRequests,
                currentUserId: { [weak session = container.session] in session?.currentUser?.id }
            )
        }
    }

    // MARK: - Inbox

    private var inbox: some View {
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
        .refreshable {
            await container.loadAllData()
        }
    }

    // MARK: - Search

    private func openSelection(_ selection: SearchSelection) {
        guard let search else { return }
        switch selection {
        case .person(let person):
            search.rememberPerson(person)
            router.push(.person(PersonRoute(id: person.id, name: person.fullName, avatarUrl: person.avatarUrl, zoomsFromRow: true)))
        case .channel(let channel):
            search.rememberChannel(channel)
            router.push(.chat(.channel(channel)))
        case .recent(let item):
            search.remember(item)
            switch item.kind {
            case .person:
                router.push(.person(PersonRoute(id: item.targetId, name: item.title, avatarUrl: item.avatarUrl)))
            case .channel:
                router.push(.chat(ChatRoute(type: .channel, targetId: item.targetId, title: item.title)))
            }
        case .message(let hit):
            router.push(.chat(hit.route))
        case .allPeople:
            search.showAllPeople()
        }
    }

    private func openFirstResult() {
        guard let search, let target = search.firstResult else { return }
        let state = search.state
        switch target {
        case .person(let id):
            if let match = state.people.first(where: { $0.person.id == id }) { openSelection(.person(match.person)) }
        case .channel(let id):
            if let match = state.channels.first(where: { $0.channel.id == id }) { openSelection(.channel(match.channel)) }
        case .message(let id):
            if let hit = state.messages.hits?.first(where: { $0.message.id == id }) { openSelection(.message(hit)) }
        }
    }

    // MARK: - Direct List

    private var directConversationsList: some View {
        List {
            if conversations.directConversations.isEmpty {
                if ListLoadStateView.replacesEmptyState(conversations.directState) {
                    ListLoadStateView(state: conversations.directState, failureTitle: "Не удалось загрузить диалоги") {
                        await conversations.loadDirectConversations()
                    }
                    .listRowBackground(Color.clear)
                } else {
                    ContentUnavailableView(
                        "Нет активных диалогов",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Нажмите карандаш сверху, чтобы начать диалог с коллегой")
                    )
                    .listRowBackground(Color.clear)
                }
            } else {
                ForEach(conversations.directConversations) { conv in
                    NavigationLink(value: AppRoute.chat(ChatRoute(
                        type: .direct,
                        targetId: conv.userId,
                        title: conv.fullName,
                        avatarUrl: conv.avatarUrl,
                        status: conv.status
                    ))) {
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
        .accessibilityIdentifier("chats-direct-list")
    }

    // MARK: - Channels List

    private var channelsList: some View {
        List {
            if conversations.channels.isEmpty {
                if ListLoadStateView.replacesEmptyState(conversations.channelsState) {
                    ListLoadStateView(state: conversations.channelsState, failureTitle: "Не удалось загрузить каналы") {
                        await conversations.loadChannels()
                    }
                    .listRowBackground(Color.clear)
                } else {
                    ContentUnavailableView(
                        "Нет доступных каналов",
                        systemImage: "number",
                        description: Text("Создайте новый канал для координации")
                    )
                    .listRowBackground(Color.clear)
                }
            } else {
                ForEach(conversations.channels) { channel in
                    NavigationLink(value: AppRoute.chat(.channel(channel))) {
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
        .accessibilityIdentifier("chats-channels-list")
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
