#if DEBUG
import SwiftUI

/// The visual component library on one screen, for review screenshots (UI tests launch it with
/// `-centychat-ui-gallery`; Debug UI-test builds only): every delivery state of a bubble, a failed
/// message with «Повторить / Удалить», a file, a reply, the typing bubble, date and jump pills,
/// the connection banners, the empty states with their spot illustrations, skeletons, the buttons,
/// the «Ознакомлен» stamp and the call stage parts. Canned data, no network.
struct DesignGalleryView: View {
    enum Page: String, CaseIterable, Identifiable {
        case messages = "Сообщения"
        case states = "Состояния"
        case controls = "Кнопки"
        case call = "Звонок"

        var id: String { rawValue }
    }

    @Environment(AppContainer.self) private var container
    @State private var page: Page = .messages
    @State private var confirmed = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Раздел", selection: $page) {
                    ForEach(Page.allCases) { page in
                        Text(page.rawValue).tag(page)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .accessibilityIdentifier("gallery-pages")
                ScrollView {
                    content
                        .padding(16)
                        .frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("design-gallery")
            }
            .background(page == .messages ? CentyColors.canvas : CentyColors.list)
            .navigationTitle("Компоненты")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch page {
        case .messages: messages
        case .states: states
        case .controls: controls
        case .call: call
        }
    }

    private var messages: some View {
        let list = PreviewData.messages()
        let rows = ChatTimeline.rows(list, me: PreviewData.me.id)
        return VStack(spacing: 0) {
            DateSeparator(date: Date())
            ForEach(rows) { row in
                MessageBubbleView(
                    message: row.message,
                    isCurrentUser: row.message.senderId == PreviewData.me.id,
                    showSenderHeader: false,
                    showsMeta: true,
                    startsGroup: row.startsGroup,
                    endsGroup: row.endsGroup,
                    transfer: nil,
                    thumbnails: container.thumbnails,
                    onAction: { _, _ in },
                    onOpenAttachment: { _ in }
                )
                .padding(.top, row.startsGroup ? 8 : 2)
            }
            HStack {
                TypingBubble()
                Spacer()
            }
            .padding(.top, 8)
            HStack {
                Spacer()
                JumpToLatestPill(newCount: 2) {}
            }
            .padding(.top, 12)
            HStack(spacing: 16) {
                ForEach([DeliveryMark.queued, .sending, .sent, .delivered, .read, .failed], id: \.self) { mark in
                    VStack(spacing: 4) {
                        DeliveryStatusView(mark: mark)
                        Text(mark.label)
                            .font(.caption2)
                            .foregroundStyle(CentyColors.textDim)
                            .multilineTextAlignment(.center)
                    }
                }
            }
            .padding(.top, 16)
        }
        .accessibilityIdentifier("gallery-messages")
    }

    private var states: some View {
        VStack(spacing: 16) {
            ConnectionBanner(phase: .problem(.offline))
            ConnectionBanner(phase: .problem(.reconnecting))
            ConnectionBanner(phase: .backOnline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 12)], spacing: 12) {
                ForEach(SpotIllustration.allCases, id: \.self) { kind in
                    SpotIllustrationView(kind: kind)
                        .frame(maxWidth: .infinity)
                        .padding(8)
                        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(CentyColors.card))
                }
            }
            VStack(spacing: 0) {
                SkeletonRow()
                SkeletonRow(nameWidth: 120, lineWidth: 180)
            }
            .padding(.horizontal, 16)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(CentyColors.card))
            HStack {
                UnreadPill(count: 3)
                UnreadPill(count: 128)
                HUDCapsule(text: "Скопировано")
            }
        }
        .accessibilityIdentifier("gallery-states")
    }

    private var controls: some View {
        VStack(spacing: 12) {
            CentyButton(title: "Войти") {}
            CentyButton(title: "Войти", isLoading: true) {}
            CentyButton(title: "Войти", isEnabled: false) {}
            CentyButton(title: "Найти сотрудника", icon: "person.2", variant: .secondary) {}
            Button("Очистить поиск") {}
                .buttonStyle(CentyLinkButtonStyle())
            AcknowledgeButton(isConfirmed: confirmed, confirmedAt: confirmed ? Date() : nil, isBusy: false) {
                confirmed = true
            }
            AcknowledgeButton(isConfirmed: true, confirmedAt: Date(), isBusy: false) {}
            HStack(spacing: 12) {
                AvatarView(name: "Алиса Тестова", status: .online, size: 44, ringColor: CentyColors.list)
                AvatarView(name: "Боб Тестов", status: .away, size: 44, ringColor: CentyColors.list, isTyping: true)
                AvatarView(name: "Карина Смирнова", status: .dnd, size: 44, ringColor: CentyColors.list)
                AvatarView(name: "Данияр Нурпеисов", status: .offline, size: 44, ringColor: CentyColors.list)
                ChannelAvatar(size: 44)
            }
            ImportanceMarker(priority: .critical)
        }
        .accessibilityIdentifier("gallery-controls")
    }

    private var call: some View {
        VStack(spacing: 24) {
            ZStack {
                BreathingRing(isActive: true, diameter: 156)
                AvatarView(name: "Боб Тестов", size: 120, ringColor: CentyColors.callBackground)
            }
            Text("Боб Тестов")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color.white)
            LevelMeter(level: 0.62)
            HStack(spacing: 32) {
                CallControlButton(title: "Микрофон выкл.", systemImage: "mic.slash.fill", isOn: true, identifier: "gallery-mute") {}
                CallControlButton(title: "Динамик", systemImage: "speaker.wave.3.fill", identifier: "gallery-speaker") {}
                CallControlButton(title: "Завершить", systemImage: "phone.down.fill", fill: CentyColors.dangerFill, identifier: "gallery-end") {}
            }
        }
        .padding(.vertical, 32)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(CentyColors.callBackground))
        .environment(\.colorScheme, .dark)
        .accessibilityIdentifier("gallery-call")
    }
}

#Preview("Галерея") {
    DesignGalleryView()
        .previewEnvironment()
}
#endif
