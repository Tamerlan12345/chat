import SwiftUI

// MARK: - Support contact

/// «Связаться с поддержкой»: only when the server settings carry a contact.
public enum SupportContact {
    /// An e-mail address becomes `mailto:`, an `https` link stays as is; anything else is refused.
    public static func url(from raw: String?) -> URL? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.contains(where: \.isWhitespace) else { return nil }
        if value.lowercased().hasPrefix("https://") {
            return URL(string: value)
        }
        if value.lowercased().hasPrefix("mailto:") {
            return URL(string: value)
        }
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        guard !value.contains("://"), parts.count == 2, !parts[0].isEmpty,
              let domain = parts.last, domain.contains(".") else { return nil }
        return URL(string: "mailto:\(value)")
    }
}

// MARK: - Report

/// What a report is about.
struct ReportTarget: Identifiable, Equatable {
    let type: ReportTargetType
    let id: Int64
    /// Shown in the sheet: the person's name or a message excerpt.
    let subject: String
}

/// Reason picker and optional details; sends `POST /api/reports`.
struct ReportSheetView: View {
    @Environment(AccountStore.self) private var account
    @Environment(\.dismiss) private var dismiss

    let target: ReportTarget

    @State private var reason: ReportReason = .spam
    @State private var details = ""
    @State private var isSending = false
    @State private var failure: AccountFailure?
    @State private var isSent = false

    private static let detailsLimit = 1000

    var body: some View {
        NavigationStack {
            Group {
                if isSent {
                    sentState
                } else {
                    form
                }
            }
            .navigationTitle(target.type == .message ? "Жалоба на сообщение" : "Жалоба на пользователя")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isSent ? "Закрыть" : "Отмена") { dismiss() }
                        .accessibilityIdentifier("report-close")
                }
            }
        }
        .interactiveDismissDisabled(isSending)
    }

    private var form: some View {
        Form {
            Section {
                Text(target.subject)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
            } header: {
                Text("На что жалоба")
            }

            Section {
                ForEach(ReportReason.allCases) { item in
                    Button {
                        reason = item
                    } label: {
                        HStack {
                            Text(item.title)
                                .foregroundStyle(.primary)
                            Spacer()
                            if reason == item {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(CentyColors.primaryBlue)
                                    .accessibilityHidden(true)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityAddTraits(reason == item ? .isSelected : [])
                    .accessibilityIdentifier("report-reason-\(item.rawValue)")
                }
            } header: {
                Text("Причина")
            }

            Section {
                TextField("Что произошло (необязательно)", text: $details, axis: .vertical)
                    .lineLimit(3...8)
                    .onChange(of: details) {
                        if details.count > Self.detailsLimit {
                            details = String(details.prefix(Self.detailsLimit))
                        }
                    }
                    .accessibilityIdentifier("report-details")
            } header: {
                Text("Подробности")
            } footer: {
                Text("Жалобу рассмотрит администратор. Автор не узнает, кто пожаловался.")
            }

            if let message = failure?.message(at: .now) {
                Section {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(CentyColors.dangerText)
                        .accessibilityIdentifier("report-error")
                }
            }

            Section {
                Button(action: send) {
                    HStack {
                        Spacer()
                        if isSending { ProgressView() }
                        Text(isSending ? "Отправка…" : "Отправить жалобу")
                            .font(.body.weight(.semibold))
                        Spacer()
                    }
                }
                .disabled(isSending)
                .accessibilityIdentifier("report-submit")
            }
        }
    }

    private var sentState: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(CentyColors.statusOnline)
                .accessibilityHidden(true)
            Text("Жалоба отправлена")
                .font(.title3.weight(.semibold))
            Text("Спасибо. Администратор рассмотрит её. Чтобы больше не видеть сообщения этого человека, его можно заблокировать.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("report-sent")
    }

    private func send() {
        guard !isSending else { return }
        isSending = true
        failure = nil
        Task {
            let result = await account.report(
                targetType: target.type,
                targetId: target.id,
                reason: reason,
                details: details
            )
            isSending = false
            if let result {
                failure = result
                CentyHaptics.error()
            } else {
                isSent = true
                CentyHaptics.success()
            }
        }
    }
}

// MARK: - Blocked users

struct BlockedUsersView: View {
    @Environment(AccountStore.self) private var account
    @State private var errorMessage: String?

    var body: some View {
        List {
            if account.blocked.isEmpty {
                Section {
                    Text(account.blocksState.isLoading ? "Загрузка…" : "Вы никого не блокировали.")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("blocked-empty")
                } footer: {
                    Text("Заблокировать человека можно в диалоге: меню «⋯» вверху, пункт «Заблокировать».")
                }
            } else {
                Section {
                    ForEach(account.blocked) { user in
                        HStack(spacing: 12) {
                            AvatarView(name: user.name, avatarUrl: nil, size: 40)
                            Text(user.name)
                                .font(.body)
                            Spacer()
                            Button("Разблокировать") {
                                Task {
                                    if let failure = await account.unblock(userId: user.id) {
                                        errorMessage = failure.message(at: .now)
                                    }
                                }
                            }
                            .buttonStyle(.bordered)
                            .disabled(account.busyUserIds.contains(user.id))
                            .accessibilityLabel("Разблокировать \(user.name)")
                            .accessibilityIdentifier("unblock-\(user.id)")
                        }
                    }
                } footer: {
                    Text("Сообщения заблокированных людей скрыты на этом устройстве.")
                }
            }

            if case .failed(let message) = account.blocksState, !message.isEmpty {
                Section {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(CentyColors.dangerText)
                }
            }
        }
        .navigationTitle("Заблокированные")
        .navigationBarTitleDisplayMode(.inline)
        .task { await account.loadBlocks() }
        .alert(
            "Не удалось разблокировать",
            isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
        ) {
            Button("ОК", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }
}

// MARK: - Account deletion

/// Re-asks for the password, then a final confirmation, then deletes the account.
struct DeleteAccountView: View {
    @Environment(AccountStore.self) private var account
    @Environment(AppContainer.self) private var container
    @Environment(\.dismiss) private var dismiss

    @State private var password = ""
    @State private var isPasswordVisible = false
    @State private var showsConfirmation = false
    @State private var failure: AccountFailure?
    @FocusState private var passwordFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label {
                        Text("Аккаунт, переписка и личные данные будут удалены безвозвратно. Восстановить их нельзя.")
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(CentyColors.centrasRed)
                    }
                    .font(.subheadline)
                }

                Section {
                    HStack {
                        Group {
                            if isPasswordVisible {
                                TextField("Пароль", text: $password)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                            } else {
                                SecureField("Пароль", text: $password)
                            }
                        }
                        .passwordContent(.password)
                        .focused($passwordFocused)
                        .privacySensitive()
                        .accessibilityLabel("Пароль")
                        .accessibilityIdentifier("delete-password")

                        Button {
                            isPasswordVisible.toggle()
                        } label: {
                            Image(systemName: isPasswordVisible ? "eye.slash" : "eye")
                                .foregroundStyle(.secondary)
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(isPasswordVisible ? "Скрыть пароль" : "Показать пароль")
                    }
                } header: {
                    Text("Введите пароль для подтверждения")
                }

                if let message = failure?.message(at: .now) {
                    Section {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(CentyColors.dangerText)
                            .accessibilityIdentifier("delete-error")
                    }
                }

                Section {
                    Button(role: .destructive) {
                        passwordFocused = false
                        showsConfirmation = true
                    } label: {
                        HStack {
                            Spacer()
                            if account.isDeleting { ProgressView() }
                            Text(account.isDeleting ? "Удаление…" : "Удалить аккаунт")
                                .font(.body.weight(.semibold))
                            Spacer()
                        }
                    }
                    .disabled(password.isEmpty || account.isDeleting)
                    .accessibilityIdentifier("delete-confirm")
                }
            }
            .navigationTitle("Удаление аккаунта")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                        .disabled(account.isDeleting)
                        .accessibilityIdentifier("delete-cancel")
                }
            }
            .alert("Удалить аккаунт навсегда?", isPresented: $showsConfirmation) {
                Button("Отмена", role: .cancel) {}
                Button("Удалить", role: .destructive) { delete() }
            } message: {
                if let unsent = UnsentNotice.text(container.delivery.unsentCount) {
                    Text(verbatim: unsent + ". " + String(localized: "Это действие нельзя отменить."))
                } else {
                    Text("Это действие нельзя отменить.")
                }
            }
        }
        .interactiveDismissDisabled(account.isDeleting)
    }

    private func delete() {
        failure = nil
        Task {
            // Success signs out and replaces this screen with login; only a failure comes back here.
            if let result = await account.deleteAccount(password: password) {
                failure = result
                CentyHaptics.error()
            }
        }
    }
}
