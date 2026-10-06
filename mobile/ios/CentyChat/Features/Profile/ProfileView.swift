import SwiftUI

/// «Профиль»: a native inset grouped list on the L1 plane — the header (avatar, name, job), the
/// status as three chips with dots, «Побудка», contacts, security («Сменить пароль», «Выйти» in the
/// danger text style), privacy, support and the account deletion.
public struct ProfileView: View {
    @Environment(SessionStore.self) private var session
    @Environment(ProfileStore.self) private var profile
    @Environment(ConversationsStore.self) private var conversations
    @Environment(AccountStore.self) private var account
    @Environment(AppContainer.self) private var container

    @State private var showChangePasswordSheet: Bool = false
    @State private var showWakeColleagueSheet: Bool = false
    @State private var showDeleteAccountSheet: Bool = false
    @State private var selectedStatus: UserStatus = .online
    /// Unsent messages wait: the sign-out asks first (they would be deleted).
    @State private var unsentWarning: String?

    public init() {}

    public var body: some View {
        NavigationStack {
            List {
                if let user = session.currentUser {
                    Section {
                        header(user)
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 0, trailing: 0))
                    }
                }

                Section {
                    StatusChips(selection: $selectedStatus)
                        .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                } header: {
                    sectionHeader("Статус")
                }
                .listRowBackground(CentyColors.card)
                .onChange(of: selectedStatus) {
                    Task { await profile.updatePresence(selectedStatus) }
                }

                Section {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Побудить коллегу")
                                .font(.body)
                                .foregroundStyle(CentyColors.textStrong)
                            Text("Сигнал и вибрация на устройстве коллеги")
                                .font(.footnote)
                                .foregroundStyle(CentyColors.textSecondary)
                        }
                        Spacer(minLength: 8)
                        if profile.wakeCooldownRemaining > 0 {
                            Text("\(profile.wakeCooldownRemaining) с")
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                                .foregroundStyle(CentyColors.textDim)
                                .contentTransition(.numericText(value: Double(profile.wakeCooldownRemaining)))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Capsule().fill(CentyColors.sunken))
                                .accessibilityLabel(Text("Можно через \(profile.wakeCooldownRemaining) с"))
                        } else {
                            Button("Выбрать") {
                                showWakeColleagueSheet = true
                            }
                            .buttonStyle(.borderless)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(CentyColors.accentText)
                            .frame(minHeight: 44)
                            .accessibilityHint(Text("Выбрать, кому отправить сигнал"))
                        }
                    }
                } header: {
                    sectionHeader("Побудка")
                }
                .listRowBackground(CentyColors.card)

                if let user = session.currentUser {
                    Section {
                        if let email = user.email {
                            LabeledContent("Эл. почта", value: email)
                        }
                        if let phone = user.phone {
                            LabeledContent("Телефон", value: phone)
                        }
                        if let ext = user.extension {
                            LabeledContent("Внутренний номер", value: ext)
                        }
                        if let company = user.company {
                            LabeledContent("Компания", value: company)
                        }
                        if let uin = user.uin {
                            LabeledContent("Идентификатор (UIN)", value: "\(uin)")
                        }
                        LabeledContent("Логин", value: user.username)
                    } header: {
                        sectionHeader("Корпоративные реквизиты")
                    }
                    .listRowBackground(CentyColors.card)
                    .foregroundStyle(CentyColors.textMain)
                }

                Section {
                    Button {
                        showChangePasswordSheet = true
                    } label: {
                        Label("Сменить пароль", systemImage: "key")
                            .foregroundStyle(CentyColors.textStrong)
                    }
                    NavigationLink {
                        BlockedUsersView()
                    } label: {
                        HStack {
                            Label("Заблокированные пользователи", systemImage: "hand.raised")
                                .foregroundStyle(CentyColors.textStrong)
                            Spacer()
                            if !account.blocked.isEmpty {
                                Text("\(account.blocked.count)")
                                    .monospacedDigit()
                                    .foregroundStyle(CentyColors.textDim)
                            }
                        }
                    }
                    .accessibilityIdentifier("profile-blocked-users")
                    if let supportURL = SupportContact.url(from: session.serverInfo.supportContact) {
                        Link(destination: supportURL) {
                            Label("Связаться с поддержкой", systemImage: "lifepreserver")
                                .foregroundStyle(CentyColors.textStrong)
                        }
                        .accessibilityIdentifier("profile-support")
                    }
                } header: {
                    sectionHeader("Безопасность и поддержка")
                }
                .listRowBackground(CentyColors.card)
                .tint(CentyColors.accentText)

                Section {
                    Button(role: .destructive) {
                        if let warning = UnsentNotice.text(container.delivery.unsentCount) {
                            unsentWarning = warning
                        } else {
                            Task { await session.logout() }
                        }
                    } label: {
                        Label("Выйти из аккаунта", systemImage: "rectangle.portrait.and.arrow.right")
                            .foregroundStyle(CentyColors.dangerText)
                    }
                    Button(role: .destructive) {
                        showDeleteAccountSheet = true
                    } label: {
                        Label("Удалить аккаунт", systemImage: "trash")
                            .foregroundStyle(CentyColors.dangerText)
                    }
                    .accessibilityIdentifier("profile-delete-account")
                } footer: {
                    Text("Удаление аккаунта необратимо.")
                        .foregroundStyle(CentyColors.textDim)
                }
                .listRowBackground(CentyColors.card)
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(24)
            .scrollContentBackground(.hidden)
            .background(CentyColors.list)
            .accessibilityIdentifier("profile-list")
            .navigationTitle("Профиль")
            .connectionBanner()
            .onAppear {
                if let user = session.currentUser {
                    selectedStatus = user.status
                }
            }
            .alert(
                "Выйти из аккаунта?",
                isPresented: Binding(get: { unsentWarning != nil }, set: { if !$0 { unsentWarning = nil } })
            ) {
                Button("Отмена", role: .cancel) { unsentWarning = nil }
                Button("Выйти", role: .destructive) {
                    unsentWarning = nil
                    Task { await session.logout() }
                }
            } message: {
                Text(unsentWarning ?? "")
            }
            .sheet(isPresented: $showChangePasswordSheet) {
                ChangePasswordModalView(isMandatory: false)
            }
            .sheet(isPresented: $showDeleteAccountSheet) {
                DeleteAccountView()
            }
            .sheet(isPresented: $showWakeColleagueSheet) {
                wakeColleaguePickerSheet
            }
        }
    }

    private func header(_ user: User) -> some View {
        HStack(spacing: 16) {
            AvatarView(name: user.fullName, avatarUrl: user.avatarUrl, status: selectedStatus, size: 64, ringColor: CentyColors.list)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(user.fullName)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(CentyColors.textStrong)
                    .accessibilityAddTraits(.isHeader)
                Text(user.jobTitle ?? user.roleName ?? String(localized: "Сотрудник"))
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textSecondary)
                if let department = user.departmentName {
                    Text(department)
                        .font(.footnote)
                        .foregroundStyle(CentyColors.textDim)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }

    private func sectionHeader(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(CentyColors.textDim)
            .textCase(nil)
    }

    // MARK: - Wake Colleague Picker

    private var wakeColleaguePickerSheet: some View {
        NavigationStack {
            List(conversations.users.filter { $0.id != session.currentUser?.id }) { colleague in
                Button {
                    showWakeColleagueSheet = false
                    Task {
                        await profile.sendWake(targetUserId: colleague.id)
                    }
                } label: {
                    HStack(spacing: 12) {
                        AvatarView(name: colleague.fullName, avatarUrl: colleague.avatarUrl, status: colleague.status, size: 40)
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
                        Spacer()
                        Image(systemName: "bell.badge")
                            .foregroundStyle(CentyColors.accentText)
                            .accessibilityHidden(true)
                    }
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(CentyColors.card)
                .accessibilityHint(Text("Отправить сигнал"))
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(CentyColors.list)
            .navigationTitle("Кому отправить сигнал")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { showWakeColleagueSheet = false }
                }
            }
        }
    }
}

/// «В сети · Отошёл · Не беспокоить» as chips with their dot; the selected one is `primary-soft`.
private struct StatusChips: View {
    @Binding var selection: UserStatus

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
        layout {
            ForEach([UserStatus.online, .away, .dnd], id: \.self) { status in
                Button {
                    selection = status
                    CentyHaptics.light()
                } label: {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(status.color)
                            .frame(width: 8, height: 8)
                        Text(status.displayName)
                            .font(.subheadline.weight(selection == status ? .semibold : .regular))
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                    }
                    .foregroundStyle(selection == status ? CentyColors.accentText : CentyColors.textSecondary)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 36)
                    .background(Capsule().fill(selection == status ? CentyColors.primarySoft : CentyColors.sunken))
                    .frame(minHeight: 44)
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == status ? .isSelected : [])
                .accessibilityIdentifier("profile-status-\(status.rawValue)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Статус"))
    }
}

#if DEBUG
#Preview("Профиль") {
    ProfileView()
        .previewEnvironment()
}
#endif
