import SwiftUI

/// Экран профиля сотрудника с управлением статусом присутствия и функцией побудки
public struct ProfileView: View {
    @Environment(SessionStore.self) private var session
    @Environment(ProfileStore.self) private var profile
    @Environment(ConversationsStore.self) private var conversations
    @Environment(AccountStore.self) private var account

    @State private var showChangePasswordSheet: Bool = false
    @State private var showWakeColleagueSheet: Bool = false
    @State private var showDeleteAccountSheet: Bool = false
    @State private var selectedStatus: UserStatus = .online
    @State private var customStatusText: String = ""

    public init() {}

    public var body: some View {
        NavigationStack {
            List {
                // Карточка пользователя
                if let user = session.currentUser {
                    Section {
                        HStack(spacing: 16) {
                            AvatarView(name: user.fullName, avatarUrl: user.avatarUrl, size: 70)

                            VStack(alignment: .leading, spacing: 4) {
                                Text(user.fullName)
                                    .font(.title3.weight(.bold))

                                Text(user.jobTitle ?? user.roleName ?? String(localized: "Сотрудник"))
                                    .font(.subheadline)
                                    .foregroundColor(.secondary)

                                Text(user.departmentName ?? user.company ?? "")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        }
                        .padding(.vertical, 8)
                    }
                }

                // Статус присутствия
                Section(header: Text("Статус присутствия")) {
                    Picker("Статус", selection: $selectedStatus) {
                        ForEach([UserStatus.online, UserStatus.away, UserStatus.dnd], id: \.self) { status in
                            HStack {
                                Circle().fill(status.color).frame(width: 8, height: 8)
                                Text(status.displayName)
                            }
                            .tag(status)
                        }
                    }
                    .onChange(of: selectedStatus) {
                        Task { await updatePresenceStatus() }
                    }
                }

                // Побудка (Wake Buzzer)
                Section(header: Text("Привлечение внимания (Побудка)")) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Отправить сигнал коллеге")
                                .font(.body)
                            Text("Вызывает виброотклик и звуковой сигнал на устройстве коллеги")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }

                        Spacer()

                        if profile.wakeCooldownRemaining > 0 {
                            Text("\(profile.wakeCooldownRemaining) с")
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                                .foregroundColor(.secondary)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color(uiColor: .tertiarySystemFill))
                                .clipShape(Capsule())
                        } else {
                            Button("Выбрать") {
                                showWakeColleagueSheet = true
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(CentyColors.primaryBlue)
                        }
                    }
                }

                // Контактная информация
                if let user = session.currentUser {
                    Section(header: Text("Корпоративные реквизиты")) {
                        if let email = user.email {
                            LabeledContent("Эл. почта", value: email)
                        }
                        if let phone = user.phone {
                            LabeledContent("Телефон", value: phone)
                        }
                        if let ext = user.extension {
                            LabeledContent("Внутренний номер", value: ext)
                        }
                        if let uin = user.uin {
                            LabeledContent("Идентификатор (UIN)", value: "\(uin)")
                        }
                        LabeledContent("Логин", value: user.username)
                    }
                }

                // Безопасность
                Section(header: Text("Безопасность")) {
                    Button(action: {
                        showChangePasswordSheet = true
                    }) {
                        HStack {
                            Image(systemName: "key.fill")
                                .foregroundColor(CentyColors.primaryBlue)
                            Text("Сменить пароль")
                                .foregroundColor(.primary)
                        }
                    }

                    Button(role: .destructive, action: {
                        Task { await session.logout() }
                    }) {
                        HStack {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                            Text("Выйти из аккаунта")
                        }
                    }
                }

                // Конфиденциальность и поддержка
                Section(header: Text("Конфиденциальность")) {
                    NavigationLink {
                        BlockedUsersView()
                    } label: {
                        HStack {
                            Image(systemName: "hand.raised.fill")
                                .foregroundColor(CentyColors.primaryBlue)
                            Text("Заблокированные пользователи")
                            Spacer()
                            if !account.blocked.isEmpty {
                                Text("\(account.blocked.count)")
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("profile-blocked-users")
                }

                if let supportURL = SupportContact.url(from: session.serverInfo.supportContact) {
                    Section(header: Text("Поддержка")) {
                        Link(destination: supportURL) {
                            HStack {
                                Image(systemName: "lifepreserver")
                                    .foregroundColor(CentyColors.primaryBlue)
                                Text("Связаться с поддержкой")
                                    .foregroundColor(.primary)
                            }
                        }
                        .accessibilityIdentifier("profile-support")
                    }
                }

                Section(header: Text("Аккаунт"), footer: Text("Удаление аккаунта необратимо.")) {
                    Button(role: .destructive, action: {
                        showDeleteAccountSheet = true
                    }) {
                        HStack {
                            Image(systemName: "trash")
                            Text("Удалить аккаунт")
                        }
                    }
                    .accessibilityIdentifier("profile-delete-account")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Профиль")
            .onAppear {
                if let user = session.currentUser {
                    selectedStatus = user.status
                }
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

    // MARK: - Wake Colleague Picker

    private var wakeColleaguePickerSheet: some View {
        NavigationStack {
            List(conversations.users.filter { $0.id != session.currentUser?.id }) { colleague in
                Button(action: {
                    showWakeColleagueSheet = false
                    Task {
                        await profile.sendWake(targetUserId: colleague.id)
                    }
                }) {
                    HStack(spacing: 12) {
                        AvatarView(name: colleague.fullName, avatarUrl: colleague.avatarUrl, status: colleague.status, size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(colleague.fullName)
                                .font(.headline)
                            Text(colleague.jobTitle ?? colleague.departmentName ?? "")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        Image(systemName: "bell.badge.fill")
                            .foregroundColor(CentyColors.primaryBlue)
                    }
                }
            }
            .navigationTitle("Кому отправить сигнал")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Отмена") { showWakeColleagueSheet = false }
                }
            }
        }
    }

    private func updatePresenceStatus() async {
        await profile.updatePresence(selectedStatus)
    }
}
