import SwiftUI

/// Модальный экран обязательной или плановой смены пароля сотрудника
public struct ChangePasswordModalView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss

    public var isMandatory: Bool

    @State private var oldPassword: String = ""
    @State private var newPassword: String = ""
    @State private var confirmPassword: String = ""
    @State private var isLoading: Bool = false
    @State private var errorMessage: String? = nil
    @State private var successMessage: String? = nil

    public init(isMandatory: Bool = true) {
        self.isMandatory = isMandatory
    }

    private var isValid: Bool {
        !oldPassword.isEmpty && newPassword.count >= 8 && newPassword == confirmPassword
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Иконка замка
                    VStack(spacing: 12) {
                        Image(systemName: "lock.shield.fill")
                            .font(.system(size: 56))
                            .foregroundColor(isMandatory ? CentyColors.centrasRed : CentyColors.primaryBlue)
                            .padding(.top, 24)

                        Text(isMandatory ? "Обязательная смена пароля" : "Смена пароля")
                            .font(.title2.weight(.bold))

                        Text(isMandatory
                             ? "По требованиям корпоративной безопасности АО СК «Сентрас Иншуранс» вам необходимо установить новый пароль перед продолжением работы."
                             : "Введите текущий пароль и новый надежный пароль (минимум 8 символов).")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }

                    // Поля ввода
                    VStack(spacing: 14) {
                        CentyTextField(
                            placeholder: "Текущий пароль",
                            text: $oldPassword,
                            icon: "lock",
                            isSecure: true
                        )

                        CentyTextField(
                            placeholder: "Новый пароль (мин. 8 симв.)",
                            text: $newPassword,
                            icon: "key.fill",
                            isSecure: true
                        )

                        CentyTextField(
                            placeholder: "Повторите новый пароль",
                            text: $confirmPassword,
                            icon: "checkmark.shield",
                            isSecure: true
                        )
                    }
                    .padding(.horizontal)

                    if let error = errorMessage {
                        Text(error)
                            .font(.subheadline)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    }

                    if let success = successMessage {
                        Text(success)
                            .font(.subheadline)
                            .foregroundColor(.green)
                            .padding(.horizontal)
                    }

                    // Кнопка подтверждения
                    CentyButton(
                        title: isLoading ? "Сохранение..." : "Сменить пароль",
                        icon: "arrow.triangle.2.circlepath",
                        isLoading: isLoading,
                        isEnabled: isValid
                    ) {
                        Task { await performPasswordChange() }
                    }
                    .padding(.horizontal)

                    if !isMandatory {
                        Button("Отмена") {
                            dismiss()
                        }
                        .foregroundColor(.secondary)
                        .padding(.top, 4)
                    }
                }
            }
            .background(CentyColors.chatBackground)
            .navigationBarBackButtonHidden(isMandatory)
            .interactiveDismissDisabled(isMandatory)
            .toolbar {
                if isMandatory {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("Выйти") {
                            Task { await session.logout() }
                        }
                    }
                }
            }
        }
    }

    private func performPasswordChange() async {
        guard newPassword == confirmPassword else {
            errorMessage = "Пароли не совпадают"
            CentyHaptics.error()
            return
        }
        guard newPassword.count >= 8 else {
            errorMessage = "Новый пароль должен содержать не менее 8 символов"
            CentyHaptics.error()
            return
        }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            try await session.changePassword(oldPassword: oldPassword, newPassword: newPassword)
            CentyHaptics.success()
            dismiss()
        } catch {
            errorMessage = error.userMessage
            CentyHaptics.error()
        }
    }
}
