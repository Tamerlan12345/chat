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

/// «Чаты»: the inbox (dialogs and channels) on the L1 list plane — large title, segmented «Личные /
/// Каналы», borderless rows with hairline separators from the text edge, the connection banner only
/// while the link is down, skeleton rows on the first load. The search («Люди · Каналы · Сообщения»)
/// has its own results screen, not a filter over the list.
///
/// iPad (regular width): `NavigationSplitView` — the inbox in the sidebar, the chat in the detail.
public struct ChatListView: View {
    @Environment(AppContainer.self) private var container
    @Environment(ConversationsStore.self) private var conversations
    @Environment(PeopleRequests.self) private var peopleRequests
    @Environment(AppNavigation.self) private var navigation: AppNavigation?
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var selectedTab: ChatListTab = .direct
    @State private var showNewChatSheet: Bool = false
    @State private var showNewChannelSheet: Bool = false
    @State private var router = NavigationRouter()
    @State private var search: UniversalSearchModel?
    @State private var isSearchPresented = false
    /// iPad: the chat shown in the detail column.
    @State private var selectedChat: ChatRoute?
    @Namespace private var zoom

    public init() {}

    private var isSplit: Bool { sizeClass == .regular }

    /// The results replace the inbox while the field is focused or holds text.
    private var isSearchActive: Bool {
        isSearchPresented || !(search?.query.isEmpty ?? true)
    }

    private var searchQuery: Binding<String> {
        Binding(get: { search?.query ?? "" }, set: { search?.setQuery($0) })
    }

    private var directTabTitle: String {
        let count = conversations.unreadDirectConversations
        return count > 0 ? String(localized: "Личные (\(count))") : String(localized: "Личные")
    }

    private var channelsTabTitle: String {
        let count = conversations.unreadChannelConversations
        return count > 0 ? String(localized: "Каналы (\(count))") : String(localized: "Каналы")
    }

    public var body: some View {
        Group {
            if isSplit {
                NavigationSplitView {
                    sidebar
                } detail: {
                    NavigationStack(path: $router.path) {
                        Group {
                            if let selectedChat {
                                ChatDetailView(
                                    conversationType: selectedChat.type,
                                    targetId: selectedChat.targetId,
                                    title: selectedChat.title,
                                    avatarUrl: selectedChat.avatarUrl,
                                    status: selectedChat.status,
                                    highlightMessageId: selectedChat.highlightMessageId,
                                    // The detail column sits next to the inbox: the tab bar stays.
                                    hidesTabBar: false
                                )
                                .id(selectedChat)
                            } else {
                                EmptyStateView(illustration: .bubbles, title: "Выберите диалог", message: "Переписка откроется здесь.")
                                    .background(CentyColors.canvas)
                            }
                        }
                        .appRoutes(zoom: zoom)
                    }
                }
            } else {
                NavigationStack(path: $router.path) {
                    sidebar
                        .appRoutes(zoom: zoom)
                }
            }
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

    // MARK: - Sidebar (the inbox and its search)

    private var sidebar: some View {
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
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    if selectedTab == .direct {
                        showNewChatSheet = true
                    } else {
                        showNewChannelSheet = true
                    }
                } label: {
                    Image(systemName: selectedTab == .direct ? "square.and.pencil" : "plus")
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel(selectedTab == .direct ? "Новый диалог" : "Новый канал")
                .accessibilityIdentifier("chats-new")
            }
        }
        .sheet(isPresented: $showNewChatSheet) {
            NewDirectChatSheet { colleague in
                showNewChatSheet = false
                open(ChatRoute(
                    type: .direct,
                    targetId: colleague.id,
                    title: colleague.fullName,
                    avatarUrl: colleague.avatarUrl,
                    status: colleague.status
                ))
            }
        }
        .sheet(isPresented: $showNewChannelSheet) {
            NewChannelSheet { showNewChannelSheet = false }
        }
        .connectionBanner()
    }

    private var inbox: some View {
        VStack(spacing: 0) {
            Picker("Раздел", selection: $selectedTab) {
                Text(directTabTitle).tag(ChatListTab.direct)
                Text(channelsTabTitle).tag(ChatListTab.channels)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 8)
            .accessibilityIdentifier("chats-scope")

            if selectedTab == .direct {
                directConversationsList
            } else {
                channelsList
            }
        }
        .background(CentyColors.list)
    }

    // MARK: - Opening

    /// A chat from the inbox or the search: pushed (iPhone) or shown in the detail (iPad).
    private func open(_ route: ChatRoute) {
        if isSplit {
            router.popToRoot()
            selectedChat = route
        } else {
            router.push(.chat(route))
        }
    }

    private func openSelection(_ selection: SearchSelection) {
        guard let search else { return }
        switch selection {
        case .person(let person):
            search.rememberPerson(person)
            router.push(.person(PersonRoute(id: person.id, name: person.fullName, avatarUrl: person.avatarUrl, zoomsFromRow: !isSplit)))
        case .channel(let channel):
            search.rememberChannel(channel)
            open(.channel(channel))
        case .recent(let item):
            search.remember(item)
            switch item.kind {
            case .person:
                router.push(.person(PersonRoute(id: item.targetId, name: item.title, avatarUrl: item.avatarUrl)))
            case .channel:
                open(ChatRoute(type: .channel, targetId: item.targetId, title: item.title))
            }
        case .message(let hit):
            open(hit.route)
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

    private func isSelected(_ type: ConversationType, _ id: Int64) -> Bool {
        isSplit && selectedChat?.type == type && selectedChat?.targetId == id
    }

    // MARK: - Lists

    private var directConversationsList: some View {
        Group {
            if conversations.directConversations.isEmpty {
                ListPlaceholder(
                    state: conversations.directState,
                    failure: "Не удалось загрузить диалоги",
                    retry: { await conversations.loadDirectConversations() }
                ) {
                    EmptyStateView(
                        illustration: .bubbles,
                        title: "Пока нет диалогов",
                        message: "Напишите коллеге — переписка появится здесь."
                    ) {
                        EmptyStateAction(title: "Найти сотрудника", systemImage: "person.2") {
                            navigation?.selectedTab = .people
                        }
                        .accessibilityIdentifier("chats-find-colleague")
                    }
                }
            } else {
                List {
                    ForEach(conversations.directConversations) { conversation in
                        let route = ChatRoute(
                            type: .direct,
                            targetId: conversation.userId,
                            title: conversation.fullName,
                            avatarUrl: conversation.avatarUrl,
                            status: conversation.status,
                            zoomsFromRow: !isSplit
                        )
                        InboxRow(route: route, isSplit: isSplit, isSelected: isSelected(.direct, conversation.userId), open: open) {
                            ConversationRowView(
                                conversation: conversation,
                                typing: conversations.typingUsers[ConversationsStore.typingKey(for: ConversationKey(type: .direct, targetId: conversation.userId))],
                                zoom: zoom
                            )
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(CentyColors.list)
        .refreshable { await container.loadAllData() }
        .accessibilityIdentifier("chats-direct-list")
    }

    private var channelsList: some View {
        Group {
            if conversations.channels.isEmpty {
                ListPlaceholder(
                    state: conversations.channelsState,
                    failure: "Не удалось загрузить каналы",
                    retry: { await conversations.loadChannels() }
                ) {
                    EmptyStateView(
                        illustration: .channel,
                        title: "Пока нет каналов",
                        message: "Каналы собирают отдел или проект в одной переписке."
                    ) {
                        EmptyStateAction(title: "Создать канал", systemImage: "plus") {
                            showNewChannelSheet = true
                        }
                    }
                }
            } else {
                List {
                    ForEach(conversations.channels) { channel in
                        let route: ChatRoute = {
                            var route = ChatRoute.channel(channel)
                            route.zoomsFromRow = !isSplit
                            return route
                        }()
                        InboxRow(route: route, isSplit: isSplit, isSelected: isSelected(.channel, channel.id), open: open) {
                            ChannelRowView(
                                channel: channel,
                                typing: conversations.typingUsers[ConversationsStore.typingKey(for: ConversationKey(type: .channel, targetId: channel.id))],
                                zoom: zoom
                            )
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(CentyColors.list)
        .refreshable { await container.loadAllData() }
        .accessibilityIdentifier("chats-channels-list")
    }
}

/// An empty list: skeleton rows while it loads (never a centred spinner), the offline illustration
/// with «Повторить» when it failed, the screen's own empty state once loaded.
struct ListPlaceholder<Empty: View>: View {
    let state: LoadState
    let failure: LocalizedStringKey
    let retry: @MainActor @Sendable () async -> Void
    @ViewBuilder let empty: () -> Empty

    var body: some View {
        switch state {
        case .idle, .loading:
            SkeletonList()
        case .failed(let message):
            EmptyStateView(illustration: .offline, title: failure, message: LocalizedStringKey(message)) {
                EmptyStateAction(title: "Повторить", systemImage: "arrow.clockwise") {
                    Task { await retry() }
                }
                .accessibilityIdentifier("list-retry")
            }
        case .loaded:
            empty()
        }
    }
}

/// An inbox row on the L1 plane: a navigation link on iPhone (pushes the chat), a button with the
/// `primary-soft` selection on iPad (shows it in the detail column). Hairline separators start at
/// the text edge.
private struct InboxRow<Label: View>: View {
    let route: ChatRoute
    let isSplit: Bool
    let isSelected: Bool
    let open: (ChatRoute) -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Group {
            if isSplit {
                Button {
                    open(route)
                } label: {
                    label()
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            } else {
                NavigationLink(value: AppRoute.chat(route)) {
                    label()
                }
            }
        }
        .listRowBackground(isSelected ? CentyColors.primarySoft : CentyColors.list)
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
        .listRowSeparatorTint(CentyColors.border)
        .accessibilityHint(Text("Открыть переписку"))
    }
}

// MARK: - New dialog and new channel

/// «Новый диалог»: colleagues with their photo, presence and job title; tapping one opens the dialog.
private struct NewDirectChatSheet: View {
    @Environment(ConversationsStore.self) private var conversations
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let choose: (PublicUser) -> Void

    @State private var query = ""

    private var colleagues: [PublicUser] {
        let others = conversations.users.filter { $0.id != session.currentUser?.id && $0.isActive }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return others }
        return others.filter { $0.fullName.localizedCaseInsensitiveContains(trimmed) }
    }

    var body: some View {
        NavigationStack {
            List(colleagues) { colleague in
                Button {
                    choose(colleague)
                } label: {
                    HStack(spacing: 12) {
                        AvatarView(name: colleague.fullName, avatarUrl: colleague.avatarUrl, status: colleague.status, size: 40, ringColor: CentyColors.card)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(colleague.fullName)
                                .font(.headline)
                                .foregroundStyle(CentyColors.textStrong)
                            if let subtitle = colleague.jobTitle ?? colleague.departmentName {
                                Text(subtitle)
                                    .font(.subheadline)
                                    .foregroundStyle(CentyColors.textSecondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(CentyColors.card)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(CentyColors.list)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Поиск по имени")
            .navigationTitle("Новый диалог")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
            }
        }
    }
}

/// «Новый канал»: name, topic, private; «Создать канал» is the screen's one primary action.
private struct NewChannelSheet: View {
    @Environment(ConversationsStore.self) private var conversations
    let close: () -> Void

    @State private var name = ""
    @State private var topic = ""
    @State private var isPrivate = false
    @State private var isCreating = false
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Название (например: #Проект)", text: $name)
                    TextField("Тема (необязательно)", text: $topic)
                    Toggle("Приватный канал", isOn: $isPrivate)
                        .tint(CentyColors.primaryBlue)
                } header: {
                    Text("Параметры канала")
                } footer: {
                    if failed {
                        Text("Не удалось создать канал. Проверьте название и попробуйте ещё раз.")
                            .foregroundStyle(CentyColors.dangerText)
                    }
                }
                .listRowBackground(CentyColors.card)

                Section {
                    CentyButton(
                        title: "Создать канал",
                        isLoading: isCreating,
                        isEnabled: !name.trimmingCharacters(in: .whitespaces).isEmpty
                    ) {
                        Task { await create() }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(CentyColors.list)
            .navigationTitle("Новый канал")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", action: close)
                }
            }
        }
    }

    private func create() async {
        isCreating = true
        failed = false
        defer { isCreating = false }
        do {
            try await conversations.createChannel(name: name, topic: topic, isPrivate: isPrivate)
            CentyHaptics.success()
            close()
        } catch {
            Log.chat.error("Creating channel failed: \(error.localizedDescription, privacy: .public)")
            failed = true
            CentyHaptics.error()
        }
    }
}

#if DEBUG
#Preview("Чаты") {
    ChatListView()
        .previewEnvironment()
}
#endif
