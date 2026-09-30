import SwiftUI

/// Экран корпоративных оповещений и распоряжений с подтверждением ознакомления
public struct AnnouncementsView: View {
    @Environment(AppState.self) private var appState
    
    @State private var selectedAnnouncement: Announcement? = nil
    @State private var filterUnconfirmedOnly: Bool = false
    @State private var isAcknowledging: Bool = false
    
    public init() {}
    
    private var displayedAnnouncements: [Announcement] {
        if filterUnconfirmedOnly {
            return appState.announcements.filter { !$0.isConfirmed }
        }
        return appState.announcements
    }
    
    public var body: some View {
        NavigationStack {
            List {
                // Фильтр
                Toggle("Только требующие ознакомления", isOn: $filterUnconfirmedOnly)
                    .font(.subheadline)
                    .listRowBackground(Color(uiColor: .secondarySystemGroupedBackground))
                
                if displayedAnnouncements.isEmpty {
                    ContentUnavailableView(
                        filterUnconfirmedOnly ? "Все распоряжения подписаны" : "Нет активных оповещений",
                        systemImage: "bell.slash",
                        description: Text("Здесь отображаются важные корпоративные приказы и новости компании")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(displayedAnnouncements) { announcement in
                        announcementCard(announcement)
                            .onTapGesture {
                                selectedAnnouncement = announcement
                            }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Распоряжения")
            .refreshable {
                await appState.loadAllData()
            }
            .sheet(item: $selectedAnnouncement) { ann in
                announcementDetailSheet(ann)
            }
        }
    }
    
    // MARK: - Announcement Card
    
    private func announcementCard(_ ann: Announcement) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                // Приоритет
                priorityBadge(ann.priority)
                
                Spacer()
                
                // Статус подтверждения
                if ann.isConfirmed {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundColor(.green)
                        Text("Ознакомлен")
                            .font(.caption2.weight(.semibold))
                            .foregroundColor(.green)
                    }
                } else {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundColor(.orange)
                        Text("Требуется подпись")
                            .font(.caption2.weight(.semibold))
                            .foregroundColor(.orange)
                    }
                }
            }
            
            Text(ann.title)
                .font(.headline)
                .foregroundColor(.primary)
            
            Text(ann.content)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .lineLimit(3)
            
            HStack {
                Text(ann.authorName)
                    .font(.caption)
                    .foregroundColor(.secondary)
                
                Spacer()
                
                Text(DateParser.format(ann.createdAt).prefix(10))
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 6)
    }
    
    private func priorityBadge(_ priority: AnnouncementPriority) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(priorityColor(priority))
                .frame(width: 8, height: 8)
            Text(priority.displayName)
                .font(.caption2.weight(.bold))
                .foregroundColor(priorityColor(priority))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(priorityColor(priority).opacity(0.12))
        .clipShape(Capsule())
    }
    
    private func priorityColor(_ priority: AnnouncementPriority) -> Color {
        switch priority {
        case .normal: return CentyColors.priorityNormal
        case .urgent: return CentyColors.priorityUrgent
        case .critical: return CentyColors.priorityCritical
        }
    }
    
    // MARK: - Detail Sheet
    
    private func announcementDetailSheet(_ ann: Announcement) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack {
                        priorityBadge(ann.priority)
                        Spacer()
                        if ann.isConfirmed {
                            Text("Ознакомлен: \(ann.confirmedAt.map { DateParser.format($0).prefix(16) } ?? "")")
                                .font(.caption)
                                .foregroundColor(.green)
                        }
                    }
                    
                    Text(ann.title)
                        .font(.title2.weight(.bold))
                    
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Автор: \(ann.authorName)")
                            .font(.subheadline.weight(.semibold))
                        if let title = ann.authorJobTitle {
                            Text(title)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                    
                    Divider()
                    
                    Text(ann.content)
                        .font(.body)
                        .lineSpacing(4)
                    
                    Spacer(minLength: 40)
                    
                    if !ann.isConfirmed {
                        CentyButton(
                            title: isAcknowledging ? "Фиксация..." : "Подтверждаю ознакомление",
                            icon: "signature",
                            isLoading: isAcknowledging
                        ) {
                            Task { await acknowledgeAction(ann.id) }
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Распоряжение")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Закрыть") { selectedAnnouncement = nil }
                }
            }
        }
    }
    
    private func acknowledgeAction(_ id: Int64) async {
        isAcknowledging = true
        defer { isAcknowledging = false }
        
        do {
            let res = try await APIClient.shared.acknowledgeAnnouncement(id: id)
            if res.success {
                if let idx = appState.announcements.firstIndex(where: { $0.id == id }) {
                    appState.announcements[idx].isConfirmed = true
                    appState.announcements[idx].confirmedAt = Date()
                }
                if selectedAnnouncement?.id == id {
                    selectedAnnouncement?.isConfirmed = true
                    selectedAnnouncement?.confirmedAt = Date()
                }
                CentyHaptics.success()
            }
        } catch {
            print("[AnnouncementsView] Acknowledge error: \(error)")
            CentyHaptics.error()
        }
    }
}
