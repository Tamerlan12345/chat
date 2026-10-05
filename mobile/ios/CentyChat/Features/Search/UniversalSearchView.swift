import SwiftUI

/// What a tap in the search results opens.
enum SearchSelection {
    case person(Person)
    case channel(Channel)
    case recent(RecentItem)
    case message(MessageHit)
    case allPeople
}

/// Результаты поиска в «Чатах»: пустая строка — «Недавние»; иначе разделы в постоянном порядке
/// «Люди · Каналы · Сообщения». Люди и каналы — сразу, сообщения подтягиваются с сервера и до
/// ответа показаны двумя строками-заготовками; разделы не ждут друг друга.
struct UniversalSearchResultsView: View {
    let model: UniversalSearchModel
    let zoom: Namespace.ID
    let open: (SearchSelection) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let state = model.state
        Group {
            if state.nothingFound {
                ContentUnavailableView {
                    Label("Ничего не нашли по «\(state.query.trimmingCharacters(in: .whitespacesAndNewlines))»", systemImage: "magnifyingglass")
                } description: {
                    Text("Проверьте написание: ищем по людям, каналам и тексту сообщений.")
                } actions: {
                    Button("Очистить поиск") { model.clear() }
                        .foregroundStyle(CentyColors.accentText)
                        .accessibilityIdentifier("search-clear")
                }
            } else {
                List {
                    if state.isEmptyQuery {
                        recents(state)
                    } else {
                        people(state)
                        channels(state)
                        messages(state)
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .scrollDismissesKeyboard(.interactively)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: state.messages)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CentyColors.chatBackground)
        .accessibilityIdentifier("search-results")
    }

    // MARK: - Sections

    @ViewBuilder
    private func recents(_ state: UniversalSearchState) -> some View {
        Section {
            if state.recents.isEmpty {
                hint("Здесь появятся люди и каналы, которые вы открывали из поиска.")
            } else {
                ForEach(state.recents) { item in
                    Button {
                        open(.recent(item))
                    } label: {
                        HStack(spacing: 12) {
                            switch item.kind {
                            case .person:
                                AvatarView(name: item.title, avatarUrl: item.avatarUrl, size: 40)
                            case .channel:
                                ChannelBadge()
                            }
                            Text(item.title)
                                .font(.headline)
                                .foregroundStyle(CentyColors.textStrong)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            disclosure
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(CentyColors.cardBackground)
                    .accessibilityIdentifier("search-recent-\(item.id)")
                }
            }
        } header: {
            sectionTitle("Недавние")
        }
    }

    @ViewBuilder
    private func people(_ state: UniversalSearchState) -> some View {
        if !state.people.isEmpty {
            Section {
                ForEach(state.people) { match in
                    Button {
                        open(.person(match.person))
                    } label: {
                        HStack(spacing: 8) {
                            PersonRowView(match: match, zoom: zoom)
                            disclosure
                        }
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(CentyColors.cardBackground)
                    .accessibilityIdentifier("search-person-\(match.person.id)")
                }
                if state.peopleTotal > state.people.count {
                    Button("Все сотрудники (\(state.peopleTotal))") {
                        open(.allPeople)
                    }
                    .foregroundStyle(CentyColors.accentText)
                    .frame(minHeight: 44)
                    .listRowBackground(CentyColors.cardBackground)
                    .accessibilityIdentifier("search-all-people")
                }
            } header: {
                sectionTitle("Люди")
            }
        }
    }

    @ViewBuilder
    private func channels(_ state: UniversalSearchState) -> some View {
        if !state.channels.isEmpty {
            Section {
                ForEach(state.channels) { match in
                    Button {
                        open(.channel(match.channel))
                    } label: {
                        HStack(spacing: 12) {
                            ChannelBadge()
                            Text(Highlight.attributed(match.channel.name, match.highlights))
                                .font(.headline)
                                .foregroundStyle(CentyColors.textStrong)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            disclosure
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(CentyColors.cardBackground)
                    .accessibilityIdentifier("search-channel-\(match.channel.id)")
                }
            } header: {
                sectionTitle("Каналы")
            }
        }
    }

    @ViewBuilder
    private func messages(_ state: UniversalSearchState) -> some View {
        Section {
            switch state.messages {
            case .idle:
                hint("Сообщения ищутся от двух символов")
            case .loading:
                ForEach(0..<2, id: \.self) { index in
                    MessageSkeletonRow(wide: index == 0)
                        .listRowBackground(CentyColors.cardBackground)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Ищем сообщения")
                .accessibilityIdentifier("search-messages-loading")
            case .failed(rateLimited: let rateLimited):
                hint(
                    rateLimited
                        ? String(localized: "Слишком много поисков подряд — повторите через минуту")
                        : String(localized: "Не удалось найти сообщения"),
                    danger: true
                )
            case .found(let hits):
                if hits.isEmpty {
                    hint("В сообщениях ничего не нашли")
                } else {
                    ForEach(hits) { hit in
                        Button {
                            open(.message(hit))
                        } label: {
                            MessageHitRow(hit: hit)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(CentyColors.cardBackground)
                        .transition(.opacity)
                        .accessibilityIdentifier("search-message-\(hit.message.id)")
                    }
                }
            }
        } header: {
            sectionTitle("Сообщения")
        }
    }

    // MARK: - Pieces

    private func sectionTitle(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(CentyColors.textDim)
            .textCase(nil)
            .accessibilityAddTraits(.isHeader)
    }

    private func hint(_ text: String, danger: Bool = false) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(danger ? CentyColors.dangerText : CentyColors.textDim)
            .listRowBackground(CentyColors.cardBackground)
    }

    private var disclosure: some View {
        Image(systemName: "chevron.right")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Color(uiColor: .tertiaryLabel))
            .accessibilityHidden(true)
    }
}

/// A channel's round badge in lists (channels have no photo).
struct ChannelBadge: View {
    var size: CGFloat = 40

    var body: some View {
        Image(systemName: "number")
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(CentyColors.accentText)
            .frame(width: size, height: size)
            .background(Circle().fill(CentyColors.primarySoft))
            .accessibilityHidden(true)
    }
}

/// A found message: sender and where, time, two lines of text with the match highlighted.
private struct MessageHitRow: View {
    let hit: MessageHit

    private var sender: String {
        hit.isOwn ? String(localized: "Вы") : hit.senderName
    }

    /// Always says where the message is: a channel or a direct dialog (with whom, for own messages).
    private var location: String {
        switch hit.conversationType {
        case .channel:
            let name = hit.conversationTitle.isEmpty ? String(localized: "канал") : hit.conversationTitle
            return name.hasPrefix("#") ? name : "#" + name
        case .direct:
            return hit.isOwn && !hit.conversationTitle.isEmpty
                ? String(localized: "переписка с \(hit.conversationTitle)")
                : String(localized: "личная переписка")
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if hit.conversationType == .channel {
                ChannelBadge()
            } else {
                AvatarView(
                    name: hit.conversationTitle.isEmpty ? sender : hit.conversationTitle,
                    avatarUrl: hit.isOwn ? nil : hit.message.senderAvatar,
                    size: 40
                )
                .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(sender) · \(location)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(CentyColors.textStrong)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text(hit.message.createdAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(CentyColors.textDim)
                        .lineLimit(1)
                }
                Text(Highlight.attributed(hit.snippet, hit.highlights))
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textSecondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Two placeholder rows under the local results while the server searches messages.
private struct MessageSkeletonRow: View {
    let wide: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(Color(uiColor: .tertiarySystemFill))
                .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color(uiColor: .tertiarySystemFill))
                    .frame(width: wide ? 160 : 120, height: 14)
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color(uiColor: .quaternarySystemFill))
                    .frame(maxWidth: .infinity)
                    .frame(height: 12)
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color(uiColor: .quaternarySystemFill))
                    .frame(width: 140, height: 12)
            }
        }
        .padding(.vertical, 4)
    }
}
