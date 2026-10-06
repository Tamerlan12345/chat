import SwiftUI

/// «Объявления»: corporate announcements and orders with acknowledgement. A native inset grouped
/// list on the L1 plane; each card is a button: the importance marker is a 6-pt dot plus its label
/// (never a coloured border), an announcement awaiting acknowledgement has its title at weight 600
/// and a dot. The detail ends with «Подтверждаю ознакомление», which turns into the «Ознакомлен»
/// stamp (the check draws in, success haptic).
public struct AnnouncementsView: View {
    @Environment(AppContainer.self) private var container
    @Environment(AnnouncementsStore.self) private var store

    @State private var selectedAnnouncement: Announcement? = nil
    @State private var filterUnconfirmedOnly: Bool = false
    @State private var isAcknowledging: Bool = false

    public init() {}

    private var displayedAnnouncements: [Announcement] {
        if filterUnconfirmedOnly {
            return store.announcements.filter { !$0.isConfirmed }
        }
        return store.announcements
    }

    public var body: some View {
        NavigationStack {
            Group {
                if displayedAnnouncements.isEmpty {
                    ListPlaceholder(
                        state: store.loadState,
                        failure: "Не удалось загрузить объявления",
                        retry: { await store.load() }
                    ) {
                        if filterUnconfirmedOnly {
                            EmptyStateView(
                                illustration: .megaphone,
                                title: "Все объявления подтверждены",
                                message: "Новые распоряжения, требующие ознакомления, появятся здесь."
                            ) {
                                EmptyStateAction(title: "Показать все", systemImage: "line.3.horizontal.decrease.circle") {
                                    filterUnconfirmedOnly = false
                                }
                            }
                        } else {
                            EmptyStateView(
                                illustration: .megaphone,
                                title: "Объявлений пока нет",
                                message: "Здесь появятся приказы и новости компании."
                            )
                        }
                    }
                } else {
                    list
                }
            }
            .background(CentyColors.list)
            .refreshable { await container.loadAllData() }
            .navigationTitle("Объявления")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        filterUnconfirmedOnly.toggle()
                        CentyHaptics.light()
                    } label: {
                        Image(systemName: filterUnconfirmedOnly ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Только требующие ознакомления")
                    .accessibilityValue(filterUnconfirmedOnly ? "Включён" : "Выключен")
                    .accessibilityIdentifier("announcements-filter")
                }
            }
            .connectionBanner()
            .sheet(item: $selectedAnnouncement) { ann in
                announcementDetailSheet(ann)
            }
        }
    }

    private var list: some View {
        List {
            if filterUnconfirmedOnly {
                Section {
                    EmptyView()
                } footer: {
                    Text("Показаны только требующие ознакомления")
                        .font(.footnote)
                        .foregroundStyle(CentyColors.textDim)
                }
            }
            ForEach(displayedAnnouncements) { announcement in
                Section {
                    Button {
                        selectedAnnouncement = announcement
                    } label: {
                        AnnouncementCard(announcement: announcement)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(CentyColors.card)
                    .accessibilityHint(Text("Открыть объявление"))
                    .accessibilityIdentifier("announcement-\(announcement.id)")
                }
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(12)
        .scrollContentBackground(.hidden)
    }

    // MARK: - Detail Sheet

    private func announcementDetailSheet(_ ann: Announcement) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ImportanceMarker(priority: ann.priority)

                    Text(ann.title)
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(CentyColors.textStrong)
                        .accessibilityAddTraits(.isHeader)

                    HStack(spacing: 10) {
                        AvatarView(name: ann.authorName, size: 32)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ann.authorName)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(CentyColors.textStrong)
                            Text(subtitle(of: ann))
                                .font(.caption)
                                .foregroundStyle(CentyColors.textDim)
                        }
                    }
                    .accessibilityElement(children: .combine)

                    Rectangle()
                        .fill(CentyColors.border)
                        .frame(height: 1)

                    Text(ann.content)
                        .font(.body)
                        .foregroundStyle(CentyColors.textMain)
                        .lineSpacing(4)
                        .textSelection(.enabled)

                    AcknowledgeButton(
                        isConfirmed: ann.isConfirmed,
                        confirmedAt: ann.confirmedAt,
                        isBusy: isAcknowledging
                    ) {
                        Task { await acknowledgeAction(ann.id) }
                    }
                    .padding(.top, 16)
                }
                .padding(16)
            }
            .background(CentyColors.canvas)
            .navigationTitle("Объявление")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Закрыть") { selectedAnnouncement = nil }
                }
            }
        }
    }

    private func subtitle(of ann: Announcement) -> String {
        let date = ann.createdAt.formatted(.dateTime.day().month(.wide).hour().minute().locale(Locale(identifier: "ru_RU")))
        if let title = ann.authorJobTitle { return "\(title) · \(date)" }
        return date
    }

    private func acknowledgeAction(_ id: Int64) async {
        isAcknowledging = true
        defer { isAcknowledging = false }

        if await store.acknowledge(id: id) {
            if selectedAnnouncement?.id == id {
                selectedAnnouncement?.isConfirmed = true
                selectedAnnouncement?.confirmedAt = Date()
            }
            CentyHaptics.success()
        } else {
            CentyHaptics.error()
        }
    }
}

/// One announcement in the list: importance, «требует ознакомления» or the stamp, title, two lines
/// of text, author and date.
private struct AnnouncementCard: View {
    let announcement: Announcement

    private var needsAcknowledgement: Bool { !announcement.isConfirmed }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ImportanceMarker(priority: announcement.priority)
                Spacer(minLength: 8)
                if needsAcknowledgement {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(CentyColors.primaryBlue)
                            .frame(width: 6, height: 6)
                        Text("Требует ознакомления")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(CentyColors.accentText)
                    }
                } else {
                    Label("Ознакомлен", systemImage: "checkmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(CentyColors.successText)
                }
            }
            Text(announcement.title)
                .font(.headline.weight(needsAcknowledgement ? .semibold : .regular))
                .foregroundStyle(CentyColors.textStrong)
                .multilineTextAlignment(.leading)
            Text(announcement.content)
                .font(.subheadline)
                .foregroundStyle(CentyColors.textSecondary)
                .lineLimit(2)
            HStack {
                Text(announcement.authorName)
                Spacer(minLength: 8)
                Text(ChatDates.inboxTime(announcement.createdAt))
                    .monospacedDigit()
            }
            .font(.caption)
            .foregroundStyle(CentyColors.textDim)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// The importance of an announcement: a 6-pt dot and the label (never a coloured left border).
struct ImportanceMarker: View {
    let priority: AnnouncementPriority

    private var color: Color {
        switch priority {
        case .normal: CentyColors.textDim
        case .urgent: CentyColors.warning
        case .critical: CentyColors.danger
        }
    }

    private var textColor: Color {
        switch priority {
        case .normal: CentyColors.textDim
        case .urgent: CentyColors.warningText
        case .critical: CentyColors.dangerText
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
                .accessibilityHidden(true)
            Text(priority.displayName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(textColor)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Важность: \(priority.displayName)"))
    }
}

#if DEBUG
#Preview("Объявления") {
    AnnouncementsView()
        .previewEnvironment()
}
#endif
