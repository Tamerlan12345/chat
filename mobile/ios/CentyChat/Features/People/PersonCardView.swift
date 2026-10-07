import SwiftUI
import UIKit

/// Карточка сотрудника: шапка (аватар, имя, статус, «был(а) в сети»), действия «Написать ·
/// Позвонить · Побудить», сведения (должность, отдел, вн. номер, мобильный, почта, роль),
/// «Пожаловаться» и «Заблокировать». Своя карточка — «Редактировать профиль» вместо действий.
struct PersonCardView: View {
    let route: PersonRoute

    @Environment(AppContainer.self) private var container
    @Environment(PeopleRequests.self) private var requests
    @State private var model: PersonCardModel?

    var body: some View {
        Group {
            if let model {
                PersonCardContent(model: model, route: route)
            } else {
                CentyColors.list.ignoresSafeArea()
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let session = container.session
                let profile = container.profile
                let created = PersonCardModel(
                    userId: route.id,
                    directory: container.people,
                    currentUser: { [weak session] in session?.currentUser },
                    requests: requests,
                    // The wake cooldown is per sender on the server, so the profile's timer is shared.
                    sendWake: { [weak profile] id in await profile?.sendWake(targetUserId: id) }
                )
                container.realtime.register(created)
                model = created
            }
            await model?.load()
        }
    }
}

private struct PersonCardContent: View {
    let model: PersonCardModel
    let route: PersonRoute

    @Environment(NavigationRouter.self) private var router: NavigationRouter?
    @Environment(AppNavigation.self) private var navigation: AppNavigation?
    @Environment(AccountStore.self) private var account
    @Environment(ProfileStore.self) private var profile
    @Environment(CallStore.self) private var calls
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var reportTarget: ReportTarget?
    @State private var confirmsBlock = false
    @State private var safetyError: String?
    /// «Скопировано»: a second copy restarts the time instead of hiding early.
    @State private var copied = TransientFlag()
    /// What the short HUD says: «Скопировано», or the result of a block/unblock.
    @State private var hudText = String(localized: "Скопировано")

    /// Until the directory or the server answers, the row's name and photo.
    private var person: Person {
        model.person ?? Person(id: route.id, fullName: route.name, avatarUrl: route.avatarUrl)
    }

    private var wakeCooldown: Int {
        max(model.wakeCooldown, profile.wakeCooldownRemaining)
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: 20) {
                    header
                    if model.isSelf {
                        editProfileButton
                    } else {
                        actions
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 8)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 4, trailing: 0))
            }

            infoSection

            if !model.isSelf {
                safetySection
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(24)
        .scrollContentBackground(.hidden)
        .background(CentyColors.list)
        .accessibilityIdentifier("person-card")
        .overlay(alignment: .bottom) {
            if copied.isOn {
                HUDCapsule(text: LocalizedStringKey(hudText))
                    .padding(.bottom, 24)
                    .transition(.opacity)
                    .accessibilityIdentifier("person-copied")
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: CentyMotion.fast), value: copied.isOn)
        .sheet(item: $reportTarget) { target in
            ReportSheetView(target: target)
        }
        .alert(AppCopy.blockTitle, isPresented: $confirmsBlock) {
            Button("Отмена", role: .cancel) {}
            Button(AppCopy.blockAction, role: .destructive) { block() }
        } message: {
            Text(verbatim: AppCopy.blockBody(name: person.fullName))
        }
        .alert(
            "Не удалось выполнить действие",
            isPresented: Binding(get: { safetyError != nil }, set: { if !$0 { safetyError = nil } })
        ) {
            Button("Закрыть", role: .cancel) {}
        } message: {
            Text(safetyError ?? "")
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 8) {
            AvatarView(name: person.fullName, avatarUrl: person.avatarUrl, size: 96, ringColor: CentyColors.list)
                .accessibilityHidden(true)
            // Never red (unlike the desktop panel): on a phone that would read as an error.
            Text(person.fullName)
                .font(.title2.weight(.semibold))
                .foregroundStyle(CentyColors.textStrong)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 6) {
                StatusBadge(status: person.status, size: 8)
                    .accessibilityHidden(true)
                Text(PresenceLine.of(status: person.status, lastSeen: person.lastSeen).text)
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textSecondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("person-status")
            if let custom = person.customStatus {
                Text("«\(custom)»")
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textSecondary)
                    .multilineTextAlignment(.center)
            }
            if model.inactive {
                Text("Сотрудник больше не работает")
                    .font(.footnote)
                    .foregroundStyle(CentyColors.textDim)
            }
        }
        .padding(.horizontal, 16)
    }

    // MARK: - Actions

    private var editProfileButton: some View {
        CentyButton(title: "Редактировать профиль", icon: "person.crop.circle") {
            navigation?.selectedTab = .profile
        }
        .accessibilityIdentifier("person-edit-profile")
    }

    @ViewBuilder
    private var actions: some View {
        let callReason = model.inactive ? nil : model.call.reason
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 10))
            : AnyLayout(HStackLayout(spacing: 10))
        VStack(spacing: 8) {
            layout {
                ActionTile(
                    title: "Написать",
                    systemImage: "bubble.left.fill",
                    kind: .primary,
                    isEnabled: !model.inactive,
                    hint: model.inactive ? String(localized: "Сотрудник больше не работает") : nil,
                    identifier: "person-write"
                ) {
                    // Opened from this person's chat header: back to that chat, no second copy.
                    router?.open(chat: .direct(with: person))
                }
                ActionTile(
                    title: "Позвонить",
                    systemImage: "phone.fill",
                    kind: .tonal,
                    isEnabled: !model.inactive && model.call == .available,
                    hint: callReason ?? (model.inactive ? String(localized: "Сотрудник больше не работает") : nil),
                    identifier: "person-call"
                ) {
                    call()
                }
                ActionTile(
                    title: wakeCooldown > 0 ? String(localized: "Через \(wakeCooldown) с") : String(localized: "Побудить"),
                    systemImage: "bell.badge.fill",
                    kind: .tonal,
                    isEnabled: !model.inactive && wakeCooldown == 0,
                    hint: wakeCooldown > 0
                        ? String(localized: "Будить можно не чаще раза в минуту")
                        : String(localized: "Сигнал и вибрация на устройстве коллеги"),
                    identifier: "person-wake"
                ) {
                    model.wake()
                }
            }
            // Why «Позвонить» is off: under the row, not a toast.
            if let callReason {
                Text(callReason)
                    .font(.footnote)
                    .foregroundStyle(CentyColors.textDim)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("person-call-reason")
            }
        }
        .padding(.horizontal, 16)
    }

    private func call() {
        let peer = PublicUser(
            id: person.id,
            username: person.username,
            fullName: person.fullName,
            avatarUrl: person.avatarUrl,
            status: person.status
        )
        Task { await calls.startOutgoingCall(targetUser: peer) }
    }

    // MARK: - Info

    @ViewBuilder
    private var infoSection: some View {
        let person = self.person
        let hasInfo = [person.jobTitle, person.departmentName, person.extension, person.phone, person.email, person.roleName]
            .contains { $0 != nil }
        if hasInfo {
            Section {
                if let job = person.jobTitle {
                    LabeledContent("Должность", value: job)
                }
                if let department = person.departmentName {
                    if person.departmentId != nil {
                        Button {
                            model.showDepartment()
                        } label: {
                            LabeledContent("Отдел") {
                                HStack(spacing: 6) {
                                    Text(department)
                                    Image(systemName: "chevron.right")
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(CentyColors.textDim)
                                        .accessibilityHidden(true)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Показать в «Отделах»")
                        .accessibilityIdentifier("person-department")
                    } else {
                        LabeledContent("Отдел", value: department)
                    }
                }
                if let ext = person.extension {
                    Button {
                        copy(ext)
                    } label: {
                        LabeledContent("Вн. номер", value: ext)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Скопировать")
                }
                if let phone = person.phone {
                    contactRow(title: "Мобильный", value: phone, url: ContactLinks.dial(phone), icon: "phone.fill", hint: "Позвонить по номеру")
                        .accessibilityIdentifier("person-phone")
                }
                if let email = person.email {
                    contactRow(title: "Email", value: email, url: ContactLinks.mail(email), icon: "envelope.fill", hint: "Написать письмо")
                        .accessibilityIdentifier("person-email")
                }
                if let role = person.roleName {
                    LabeledContent("Роль", value: role)
                }
            }
            .listRowBackground(CentyColors.card)
        }
    }

    /// Tap opens the dialer / mail (only for a checked number or address), long press copies.
    private func contactRow(title: LocalizedStringKey, value: String, url: URL?, icon: String, hint: LocalizedStringKey) -> some View {
        Button {
            if let url {
                openURL(url)
            } else {
                copy(value)
            }
        } label: {
            LabeledContent(title) {
                HStack(spacing: 8) {
                    Text(value)
                        .textSelection(.disabled)
                    if url != nil {
                        Image(systemName: icon)
                            .foregroundStyle(CentyColors.accentText)
                            .accessibilityHidden(true)
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                copy(value)
            } label: {
                Label("Скопировать", systemImage: "doc.on.doc")
            }
        }
        .accessibilityHint(url != nil ? hint : "Скопировать")
    }

    private func copy(_ value: String) {
        UIPasteboard.general.string = value
        CentyHaptics.light()
        showHUD(String(localized: "Скопировано"))
    }

    /// A short notice at the bottom, read by VoiceOver.
    private func showHUD(_ text: String) {
        hudText = text
        UIAccessibility.post(notification: .announcement, argument: text)
        copied.show(for: .milliseconds(1_500))
    }

    // MARK: - Safety

    private var safetySection: some View {
        Section {
            Button {
                reportTarget = ReportTarget(type: .user, id: person.id, subject: person.fullName)
            } label: {
                Label("Пожаловаться", systemImage: "flag")
                    .foregroundStyle(CentyColors.accentText)
            }
            .accessibilityIdentifier("person-report")
            if account.isBlocked(person.id) {
                Button {
                    unblock()
                } label: {
                    Label("Разблокировать", systemImage: "hand.raised.slash")
                        .foregroundStyle(CentyColors.accentText)
                }
                .disabled(account.busyUserIds.contains(person.id))
                .accessibilityIdentifier("person-unblock")
            } else {
                Button(role: .destructive) {
                    confirmsBlock = true
                } label: {
                    Label("Заблокировать", systemImage: "hand.raised")
                        .foregroundStyle(CentyColors.dangerText)
                }
                .disabled(account.busyUserIds.contains(person.id))
                .accessibilityIdentifier("person-block")
            }
        }
        .listRowBackground(CentyColors.card)
    }

    private func block() {
        let target = person
        Task {
            if let failure = await account.block(userId: target.id, name: target.fullName) {
                safetyError = failure.message(at: .now)
                CentyHaptics.error()
            } else {
                showHUD(AppCopy.blockDone)
                CentyHaptics.warning()
            }
        }
    }

    private func unblock() {
        let target = person.id
        Task {
            if let failure = await account.unblock(userId: target) {
                safetyError = failure.retryDeadline != nil ? failure.message(at: .now) : AppCopy.unblockFailed
                CentyHaptics.error()
            } else {
                showHUD(AppCopy.unblockDone)
            }
        }
    }
}

/// «Написать» (primary), «Позвонить» and «Побудить» (tonal): 72 pt, icon above the label.
private struct ActionTile: View {
    enum Kind {
        case primary
        case tonal
    }

    let title: String
    let systemImage: String
    let kind: Kind
    let isEnabled: Bool
    let hint: String?
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button {
            CentyHaptics.light()
            action()
        } label: {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.title3)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 6)
            .frame(maxWidth: .infinity, minHeight: 72)
        }
        .buttonStyle(ActionTileStyle(kind: kind, isEnabled: isEnabled))
        .disabled(!isEnabled)
        .accessibilityHint(hint ?? "")
        .accessibilityIdentifier(identifier)
    }
}

private struct ActionTileStyle: ButtonStyle {
    let kind: ActionTile.Kind
    let isEnabled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(foreground)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(fill(pressed: configuration.isPressed))
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }

    private var foreground: Color {
        guard isEnabled else { return CentyColors.textDim }
        switch kind {
        case .primary: return CentyColors.onPrimary
        case .tonal: return CentyColors.accentText
        }
    }

    private func fill(pressed: Bool) -> Color {
        switch kind {
        case .primary:
            guard isEnabled else { return CentyColors.primaryBlue.opacity(0.38) }
            return pressed ? CentyColors.primaryPressed : CentyColors.primaryBlue
        case .tonal:
            guard isEnabled else { return CentyColors.primarySoft.opacity(0.38) }
            return pressed ? CentyColors.primarySoft.opacity(0.7) : CentyColors.primarySoft
        }
    }
}

#if DEBUG
#Preview("Карточка") {
    NavigationStack {
        PersonCardView(route: PersonRoute(id: 2, name: "Боб Тестов"))
    }
    .previewEnvironment()
}
#endif
