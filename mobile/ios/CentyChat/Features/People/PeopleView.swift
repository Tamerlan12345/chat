import SwiftUI

/// Вкладка «Сотрудники»: справочник коллег по алфавиту или по отделам, поиск, фильтр «В сети».
/// Список открывается сразу из кэша и обновляется с сервера.
public struct PeopleView: View {
    @Environment(AppContainer.self) private var container
    @Environment(PeopleRequests.self) private var requests

    /// Filters survive the process (query, scope, «В сети», open departments) — for the
    /// account that set them only: scene storage outlives sign-out.
    @SceneStorage("people.filters") private var storedFilters = ""
    @State private var model: PeopleModel?
    @State private var router = NavigationRouter()
    @Namespace private var zoom

    public init() {}

    public var body: some View {
        NavigationStack(path: $router.path) {
            Group {
                if let model {
                    PeopleSearchHost(model: model, zoom: zoom)
                } else {
                    CentyColors.chatBackground.ignoresSafeArea()
                }
            }
            .navigationTitle("Сотрудники")
            .navigationBarTitleDisplayMode(.large)
            .appRoutes(zoom: zoom)
        }
        .environment(router)
        .onAppear {
            guard model == nil else { return }
            let owner = container.session.currentUser?.id
            model = PeopleModel(directory: container.people, requests: requests, filters: .restored(from: storedFilters, owner: owner))
        }
        // «Все сотрудники (N)» from the search or «Отдел» from a card while this tab is alive.
        .onChange(of: requests.serial) {
            guard requests.pending != nil else { return }
            model?.applyPendingRequest()
            router.popToRoot()
        }
        .onChange(of: model?.filters) { _, filters in
            if let filters { storedFilters = filters.stored(for: container.session.currentUser?.id) }
        }
        // Sign-out clears the stored filters (they outlive the session in scene storage).
        .onChange(of: container.session.currentUser?.id) { _, userId in
            storedFilters = PeopleFilters.retained(storedFilters, signedInUser: userId)
        }
        .onDisappear {
            storedFilters = PeopleFilters.retained(storedFilters, signedInUser: container.session.currentUser?.id)
        }
    }
}

/// Puts the search field in the navigation bar; the content below reads `isSearching`.
private struct PeopleSearchHost: View {
    let model: PeopleModel
    let zoom: Namespace.ID

    var body: some View {
        PeopleContent(model: model, zoom: zoom)
            .searchable(
                text: Binding(get: { model.filters.query }, set: { model.setQuery($0) }),
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Имя, должность, отдел, вн. номер"
            )
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    OnlineFilterChip(isOn: model.filters.onlineOnly) {
                        model.toggleOnlineOnly()
                    }
                }
            }
    }
}

/// «В сети» in the navigation bar: a chip that fills green while the filter is on.
private struct OnlineFilterChip: View {
    let isOn: Bool
    let toggle: () -> Void

    var body: some View {
        Button {
            CentyHaptics.light()
            toggle()
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(CentyColors.statusOnline)
                    .frame(width: 8, height: 8)
                Text("В сети")
                    .font(.subheadline.weight(.semibold))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .foregroundStyle(isOn ? CentyColors.successText : CentyColors.textSecondary)
            .background(Capsule().fill(isOn ? CentyColors.successSoft : Color(uiColor: .tertiarySystemFill)))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("В сети")
        .accessibilityValue(isOn ? "Включён" : "Выключен")
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityHint("Показывать только тех, кто в сети")
        .accessibilityIdentifier("people-online-filter")
    }
}

private struct PeopleContent: View {
    let model: PeopleModel
    let zoom: Namespace.ID

    @Environment(\.isSearching) private var isSearching
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let state = model.state
        Group {
            if !state.isLoaded {
                if state.refreshFailed {
                    ContentUnavailableView {
                        Label("Не удалось загрузить сотрудников", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text("Проверьте подключение и попробуйте ещё раз.")
                    } actions: {
                        Button("Повторить") { model.refresh() }
                            .buttonStyle(.borderedProminent)
                            .tint(CentyColors.primaryBlue)
                    }
                } else {
                    skeleton
                }
            } else if state.isEmptyResult {
                emptyState(state)
            } else {
                switch state.scope {
                case .all:
                    if state.isSearching {
                        results(state)
                    } else {
                        letters(state)
                    }
                case .departments:
                    departments(state)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CentyColors.chatBackground)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await model.refreshAndWait() }
        .safeAreaInset(edge: .top, spacing: 0) {
            // Search focus: the scope switch and the summary collapse up.
            if !isSearching {
                header(state)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: isSearching)
    }

    // MARK: - Header

    private func header(_ state: PeopleUIState) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if state.isLoaded {
                Text(RussianPlural.peopleSummary(total: state.total, online: state.online))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(CentyColors.textDim)
                    .accessibilityIdentifier("people-summary")
            }
            Picker("Раздел", selection: Binding(get: { state.scope }, set: { model.setScope($0) })) {
                Text("Все").tag(PeopleScope.all)
                Text("Отделы").tag(PeopleScope.departments)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("people-scope")
            if state.isLoaded && state.refreshFailed {
                refreshFailedBanner
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .background(CentyColors.chatBackground)
    }

    private var refreshFailedBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(CentyColors.dangerText)
                .accessibilityHidden(true)
            Text("Не удалось обновить список")
                .font(.footnote)
                .foregroundStyle(CentyColors.textSecondary)
            Spacer(minLength: 8)
            Button("Повторить") { model.refresh() }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(CentyColors.accentText)
                .frame(minHeight: 44)
        }
        .padding(.horizontal, 12)
        .background(CentyColors.dangerSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("people-refresh-failed")
    }

    // MARK: - Lists

    private var skeleton: some View {
        List {
            ForEach(0..<8, id: \.self) { _ in
                PersonRowSkeleton()
                    .listRowBackground(CentyColors.cardBackground)
            }
        }
        .listStyle(.plain)
        .scrollDisabled(true)
        .accessibilityElement()
        .accessibilityLabel("Загрузка")
    }

    private func letters(_ state: PeopleUIState) -> some View {
        ScrollViewReader { proxy in
            List {
                ForEach(state.sections) { section in
                    Section {
                        ForEach(section.people) { person in
                            personLink(person) { PersonRowView(person: person, zoom: zoom) }
                        }
                    } header: {
                        Text(section.letter)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(CentyColors.textDim)
                            .accessibilityAddTraits(.isHeader)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .accessibilityIdentifier("people-list")
            .overlay(alignment: .trailing) {
                // At accessibility sizes the letters would cover the rows; VoiceOver has the headers.
                if state.sections.count > 1 && !typeSize.isAccessibilitySize {
                    SectionIndexBar(letters: state.sections.map(\.letter)) { letter in
                        guard let first = state.sections.first(where: { $0.letter == letter })?.people.first else { return }
                        proxy.scrollTo(first.id, anchor: .top)
                    }
                    .padding(.trailing, 2)
                }
            }
        }
    }

    private func results(_ state: PeopleUIState) -> some View {
        List {
            ForEach(state.results) { match in
                personLink(match.person) { PersonRowView(match: match, zoom: zoom) }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .accessibilityIdentifier("people-list")
    }

    private func departments(_ state: PeopleUIState) -> some View {
        List {
            ForEach(DepartmentOutline.rows(state.departments, expanded: state.expanded)) { row in
                switch row.kind {
                case .department(let node, expanded: let expanded):
                    Button {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                            model.toggleDepartment(node.id)
                        }
                        CentyHaptics.light()
                    } label: {
                        DepartmentRowView(node: node, expanded: expanded, depth: row.depth)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(CentyColors.cardBackground)
                    .accessibilityIdentifier("department-\(node.id)")
                case .person(let person):
                    personLink(person) {
                        PersonRowView(person: person, zoom: zoom)
                            .padding(.leading, CGFloat(row.depth) * 16)
                    }
                    .transition(.opacity)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .accessibilityIdentifier("people-list")
    }

    private func personLink<RowContent: View>(_ person: Person, @ViewBuilder label: () -> RowContent) -> some View {
        NavigationLink(value: AppRoute.person(PersonRoute(id: person.id, name: person.fullName, avatarUrl: person.avatarUrl, zoomsFromRow: true))) {
            label()
        }
        .listRowBackground(CentyColors.cardBackground)
        .accessibilityIdentifier("person-row-\(person.id)")
    }

    // MARK: - Empty

    @ViewBuilder
    private func emptyState(_ state: PeopleUIState) -> some View {
        if state.isSearching {
            ContentUnavailableView {
                Label("Никого не нашли по «\(state.query.trimmingCharacters(in: .whitespacesAndNewlines))»", systemImage: "magnifyingglass")
            } description: {
                Text("Проверьте написание или поищите по должности, отделу и внутреннему номеру.")
            } actions: {
                Button("Очистить поиск") { model.setQuery("") }
                    .foregroundStyle(CentyColors.accentText)
                    .accessibilityIdentifier("people-clear-search")
            }
        } else if state.onlineOnly {
            ContentUnavailableView {
                Label("Сейчас никого нет в сети", systemImage: "moon.zzz")
            } description: {
                Text("Выключите фильтр «В сети», чтобы увидеть всех.")
            } actions: {
                Button("Показать всех") { model.toggleOnlineOnly() }
                    .foregroundStyle(CentyColors.accentText)
            }
        } else {
            ContentUnavailableView(
                "В справочнике пока никого нет",
                systemImage: "person.2",
                description: Text("Когда администратор добавит сотрудников, они появятся здесь.")
            )
        }
    }
}

/// A department in «Отделы»: disclosure triangle, name and the «3/9 в сети» counter.
private struct DepartmentRowView: View {
    let node: DepartmentNode
    let expanded: Bool
    let depth: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(CentyColors.textDim)
                .rotationEffect(.degrees(expanded ? 90 : 0))
                .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: expanded)
                .accessibilityHidden(true)
            Text(node.name)
                .font(.body.weight(.semibold))
                .foregroundStyle(CentyColors.textStrong)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 8)
            Text("\(node.online)/\(node.total) в сети")
                .font(.caption.monospacedDigit())
                .foregroundStyle(node.online > 0 ? CentyColors.successText : CentyColors.textDim)
                .padding(.horizontal, node.online > 0 ? 8 : 0)
                .padding(.vertical, node.online > 0 ? 3 : 0)
                .background {
                    if node.online > 0 {
                        Capsule().fill(CentyColors.successSoft)
                    }
                }
        }
        .padding(.leading, CGFloat(depth) * 16)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(node.name), \(node.online) из \(node.total) в сети")
        .accessibilityValue(expanded ? "Развёрнут" : "Свёрнут")
        .accessibilityHint(expanded ? "Свернуть" : "Развернуть")
        .accessibilityAddTraits(.isButton)
    }
}
