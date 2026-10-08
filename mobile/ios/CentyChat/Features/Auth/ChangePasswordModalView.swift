import SwiftUI

/// Модальный экран обязательной или плановой смены пароля сотрудника: три поля, требования к паролю,
/// которые отмечаются по мере ввода, и одна основная кнопка.
public struct ChangePasswordModalView: View {
    private enum Field: Hashable {
        case old, new, confirm
    }

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public var isMandatory: Bool

    @State private var oldPassword: String = ""
    @State private var newPassword: String = ""
    @State private var confirmPassword: String = ""
    @State private var isLoading: Bool = false
    @State private var errorMessage: String? = nil
    @FocusState private var focus: Field?

    public init(isMandatory: Bool = true) {
        self.isMandatory = isMandatory
    }

    private var isLongEnough: Bool { newPassword.count >= 8 }
    private var matches: Bool { !confirmPassword.isEmpty && newPassword == confirmPassword }

    private var isValid: Bool {
        !oldPassword.isEmpty && isLongEnough && matches
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "lock.shield.fill")
                            .font(.system(size: 40))
                            .foregroundStyle(isMandatory ? CentyColors.warningText : CentyColors.accentText)
                            .accessibilityHidden(true)
                        Text(isMandatory ? "Обязательная смена пароля" : "Смена пароля")
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(CentyColors.textStrong)
                            .accessibilityAddTraits(.isHeader)
                        Text(isMandatory
                             ? "По требованиям корпоративной безопасности АО СК «Сентрас Иншуранс» вам необходимо установить новый пароль перед продолжением работы."
                             : "Введите текущий пароль и новый надежный пароль (минимум 8 символов).")
                            .font(.subheadline)
                            .foregroundStyle(CentyColors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    VStack(alignment: .leading, spacing: 16) {
                        if let errorMessage {
                            LoginErrorBox(message: errorMessage, identifier: "change-password-error")
                                .transition(.opacity)
                        }
                        field("Текущий пароль", text: $oldPassword, field: .old, next: .new)
                        field("Новый пароль", text: $newPassword, field: .new, next: .confirm)
                        field("Повторите новый пароль", text: $confirmPassword, field: .confirm, next: nil)

                        VStack(alignment: .leading, spacing: 6) {
                            requirement("Не короче 8 символов", met: isLongEnough)
                            requirement("Пароли совпадают", met: matches)
                        }
                        .animation(reduceMotion ? nil : .easeOut(duration: CentyMotion.fast), value: isLongEnough)
                        .animation(reduceMotion ? nil : .easeOut(duration: CentyMotion.fast), value: matches)

                        CentyButton(
                            title: "Сменить пароль",
                            isLoading: isLoading,
                            isEnabled: isValid
                        ) {
                            Task { await performPasswordChange() }
                        }
                        .accessibilityIdentifier("change-password-submit")
                        .padding(.top, 8)
                    }
                    .padding(16)
                    .background(CentyColors.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(CentyColors.border, lineWidth: 1)
                    }
                    .animation(reduceMotion ? nil : .easeOut(duration: CentyMotion.base), value: errorMessage)
                }
                .frame(maxWidth: 480)
                .padding(16)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(CentyColors.canvas.ignoresSafeArea())
            .navigationTitle(isMandatory ? "" : "Смена пароля")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(isMandatory)
            .interactiveDismissDisabled(isMandatory)
            .toolbar {
                if isMandatory {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Выйти") {
                            Task { await session.logout() }
                        }
                        .foregroundStyle(CentyColors.dangerText)
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Отмена") { dismiss() }
                            .accessibilityIdentifier("change-password-cancel")
                    }
                }
            }
        }
    }

    private func field(_ title: LocalizedStringKey, text: Binding<String>, field: Field, next: Field?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(CentyColors.textSecondary)
                .accessibilityHidden(true)
            SecureField(title, text: text)
                .textContentType(LaunchTestFixture.suppressesPasswordAutofill ? .oneTimeCode : (field == .old ? .password : .newPassword))
                .submitLabel(next == nil ? .done : .next)
                .focused($focus, equals: field)
                .onSubmit {
                    if let next {
                        focus = next
                    } else if isValid {
                        Task { await performPasswordChange() }
                    }
                }
                .privacySensitive()
                .modifier(LoginFieldStyle(isFocused: focus == field))
                .accessibilityLabel(Text(title))
        }
    }

    private func requirement(_ text: LocalizedStringKey, met: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: met ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(met ? CentyColors.successText : CentyColors.textDim)
                .contentTransition(.symbolEffect(.replace))
                .accessibilityHidden(true)
            Text(text)
                .font(.footnote)
                .foregroundStyle(met ? CentyColors.textMain : CentyColors.textDim)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(met ? Text("Выполнено") : Text("Не выполнено"))
    }

    private func performPasswordChange() async {
        guard newPassword == confirmPassword else {
            errorMessage = String(localized: "Пароли не совпадают")
            CentyHaptics.error()
            return
        }
        guard newPassword.count >= 8 else {
            errorMessage = String(localized: "Новый пароль должен содержать не менее 8 символов")
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

#if DEBUG
#Preview("Смена пароля") {
    ChangePasswordModalView(isMandatory: false)
        .previewEnvironment()
}
#endif
