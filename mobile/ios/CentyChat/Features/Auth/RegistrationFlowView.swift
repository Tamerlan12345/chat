import SwiftUI
import UIKit

/// In-app registration: the form, the e-mail code and the «waiting for the administrator» result.
/// Presented over the login screen. A confirmed registration that comes back signed in replaces
/// this screen with the app itself (the session phase changes underneath it).
struct RegistrationFlowView: View {
    private enum FocusedField: Hashable {
        case email, name, username, password, code
    }

    @State private var model: RegistrationFlowModel
    @State private var isPasswordVisible = false
    @FocusState private var focus: FocusedField?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let onClose: () -> Void

    init(
        account: any AccountRepository,
        signIn: @escaping @MainActor (AuthSuccessResponse) async -> Void,
        onClose: @escaping () -> Void
    ) {
        _model = State(initialValue: RegistrationFlowModel(account: account, signIn: signIn))
        self.onClose = onClose
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    switch model.step {
                    case .form:
                        formStep
                    case .code:
                        codeStep
                    case .pending:
                        pendingStep
                    }
                }
                .frame(maxWidth: 420)
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 24)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
            .background(CentyColors.canvas.ignoresSafeArea())
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if model.step != .pending {
                        Button("Закрыть", action: onClose)
                            .accessibilityIdentifier("register-close")
                    }
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: model.step)
        }
        .interactiveDismissDisabled(model.isBusy)
    }

    private var navigationTitle: LocalizedStringKey {
        switch model.step {
        case .form: return "Регистрация"
        case .code: return "Подтверждение почты"
        case .pending: return "Заявка отправлена"
        }
    }

    // MARK: - Step 1: form

    private var formStep: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let message = model.errorMessage(at: context.date)
            VStack(alignment: .leading, spacing: 16) {
                Text("Укажите рабочую почту: мы отправим на неё код подтверждения. После этого вход откроется сразу или после одобрения администратором.")
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let message {
                    LoginErrorBox(message: message, identifier: "register-error")
                }

                field(
                    title: "Эл. почта",
                    placeholder: "name@company.kz",
                    error: model.visibleError(for: .email),
                    focus: .email,
                    identifier: "register-email"
                ) {
                    TextField("name@company.kz", text: $model.email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .onSubmit { focus = .name }
                }

                field(
                    title: "ФИО",
                    placeholder: "Фамилия Имя Отчество",
                    error: model.visibleError(for: .displayName),
                    focus: .name,
                    identifier: "register-name"
                ) {
                    TextField("Фамилия Имя Отчество", text: $model.displayName)
                        .textContentType(.name)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.next)
                        .onSubmit { focus = .username }
                }

                field(
                    title: "Логин",
                    placeholder: "Латиница, цифры, точка, дефис",
                    error: model.visibleError(for: .username),
                    focus: .username,
                    identifier: "register-username"
                ) {
                    TextField("Латиница, цифры, точка, дефис", text: $model.username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                }

                passwordField

                Button(action: submitForm) {
                    busyLabel(title: "Получить код", busyTitle: "Отправка…")
                }
                .buttonStyle(LoginPrimaryButtonStyle(isBusy: model.isBusy, reduceMotion: reduceMotion))
                .disabled(model.isBusy || isWaiting(message))
                .accessibilityIdentifier("register-submit")
                .padding(.top, 4)

                Button(action: onClose) {
                    Text("Уже есть аккаунт? Войти")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(CentyColors.accentText)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityIdentifier("register-to-login")
            }
            .disabled(model.isBusy)
            .padding(20)
            .background(CentyColors.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(CentyColors.border, lineWidth: 1)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("register-form")
        }
    }

    private var passwordField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Пароль")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(CentyColors.textSecondary)
                .accessibilityHidden(true)
            HStack(spacing: 0) {
                Group {
                    if isPasswordVisible {
                        TextField("Не короче 8 символов", text: $model.password)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } else {
                        SecureField("Не короче 8 символов", text: $model.password)
                    }
                }
                .passwordContent(.newPassword)
                .submitLabel(.go)
                .focused($focus, equals: .password)
                .onSubmit(submitForm)
                .privacySensitive()
                .accessibilityLabel("Пароль")
                .accessibilityIdentifier("register-password")

                Button {
                    isPasswordVisible.toggle()
                    focus = .password
                } label: {
                    Image(systemName: isPasswordVisible ? "eye.slash" : "eye")
                        .foregroundStyle(CentyColors.textDim)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(isPasswordVisible ? "Скрыть пароль" : "Показать пароль")
                .accessibilityIdentifier("register-password-visibility")
            }
            .modifier(LoginFieldStyle(isFocused: focus == .password, trailingPadding: 0))
            fieldError(model.visibleError(for: .password))
        }
    }

    private func field<Content: View>(
        title: LocalizedStringKey,
        placeholder: LocalizedStringKey,
        error: String?,
        focus field: FocusedField,
        identifier: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(CentyColors.textSecondary)
                .accessibilityHidden(true)
            content()
                .focused($focus, equals: field)
                .modifier(LoginFieldStyle(isFocused: focus == field))
                .accessibilityLabel(title)
                .accessibilityIdentifier(identifier)
            fieldError(error)
        }
    }

    @ViewBuilder
    private func fieldError(_ message: String?) -> some View {
        if let message {
            Text(message)
                .font(.footnote)
                .foregroundStyle(CentyColors.dangerText)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Ошибка: \(message)")
        }
    }

    // MARK: - Step 2: code

    private var codeStep: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let date = context.date
            let message = model.errorMessage(at: date)
            let expired = model.isCodeExpired(at: date)
            let resendIn = model.secondsUntilResend(at: date)
            VStack(spacing: 16) {
                Image(systemName: "envelope.badge")
                    .font(.system(size: 44))
                    .foregroundStyle(CentyColors.primaryBlue)
                    .accessibilityHidden(true)
                Text("Введите код из письма")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(CentyColors.textStrong)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text("Мы отправили 6-значный код на \(RegistrationValidation.normalizedEmail(model.email)).")
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                VStack(alignment: .leading, spacing: 16) {
                    if let message {
                        LoginErrorBox(message: message, identifier: "register-code-error")
                    }

                    TextField("000000", text: Binding(
                        get: { model.code },
                        set: { model.updateCode($0) }
                    ))
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .multilineTextAlignment(.center)
                    .font(.system(.title, design: .monospaced).weight(.semibold))
                    .focused($focus, equals: .code)
                    .modifier(LoginFieldStyle(isFocused: focus == .code))
                    .accessibilityLabel("Код из письма")
                    .accessibilityHint("Шесть цифр")
                    .accessibilityIdentifier("register-code")

                    expiryLine(expired: expired, date: date)

                    Button(action: verify) {
                        busyLabel(title: "Подтвердить", busyTitle: "Проверка…")
                    }
                    .buttonStyle(LoginPrimaryButtonStyle(isBusy: model.isBusy, reduceMotion: reduceMotion))
                    .disabled(!model.canVerify || expired)
                    .accessibilityIdentifier("register-verify")

                    Button(action: resend) {
                        Text(resendIn > 0
                             ? "Отправить код ещё раз через \(resendIn) с"
                             : "Отправить код ещё раз")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(resendIn > 0 || model.isBusy ? CentyColors.textDim : CentyColors.accentText)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .disabled(!model.canResend(at: date))
                    .accessibilityIdentifier("register-resend")

                    Button {
                        focus = nil
                        model.backToForm()
                    } label: {
                        Text("Изменить данные")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(CentyColors.accentText)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .disabled(model.isBusy)
                    .accessibilityIdentifier("register-back")
                }
                .padding(20)
                .background(CentyColors.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(CentyColors.border, lineWidth: 1)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("register-code-screen")
        }
    }

    @ViewBuilder
    private func expiryLine(expired: Bool, date: Date) -> some View {
        if expired {
            Text("Срок действия кода истёк. Запросите новый код.")
                .font(.footnote)
                .foregroundStyle(CentyColors.dangerText)
                .fixedSize(horizontal: false, vertical: true)
        } else if let seconds = model.secondsUntilExpiry(at: date) {
            let minutes = seconds / 60
            let rest = seconds % 60
            Text("Код действует ещё \(minutes):\(rest < 10 ? "0" : "")\(rest)")
                .font(.footnote.monospacedDigit())
                .foregroundStyle(CentyColors.textDim)
        }
    }

    // MARK: - Step 3: waiting for the administrator

    private var pendingStep: some View {
        VStack(spacing: 16) {
            Image(systemName: "hourglass.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(CentyColors.primaryBlue)
                .accessibilityHidden(true)
                .padding(.top, 24)
            Text("Заявка отправлена на рассмотрение администратору")
                .font(.title3.weight(.semibold))
                .foregroundStyle(CentyColors.textStrong)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text("Почта подтверждена. Вход станет доступен после одобрения заявки администратором. Срок рассмотрения заранее неизвестен — попробуйте войти позже.")
                .font(.subheadline)
                .foregroundStyle(CentyColors.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onClose) {
                Text("Вернуться ко входу")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 48)
            }
            .buttonStyle(LoginPrimaryButtonStyle(isBusy: false, reduceMotion: reduceMotion))
            .padding(.top, 8)
            .accessibilityIdentifier("register-pending-done")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("register-pending")
    }

    // MARK: - Helpers

    private func busyLabel(title: LocalizedStringKey, busyTitle: LocalizedStringKey) -> some View {
        ZStack {
            Text(title)
                .opacity(model.isBusy ? 0 : 1)
            HStack(spacing: 8) {
                ProgressView()
                    .tint(CentyColors.onPrimary)
                Text(busyTitle)
            }
            .opacity(model.isBusy ? 1 : 0)
            .accessibilityHidden(!model.isBusy)
        }
        .font(.body.weight(.semibold))
        .frame(maxWidth: .infinity, minHeight: 48)
    }

    /// A rate-limit wait is on: the form cannot be sent again before it is over.
    private func isWaiting(_ message: String?) -> Bool {
        model.failure?.retryDeadline != nil && message != nil
    }

    private func submitForm() {
        focus = nil
        Task {
            await model.submitForm()
            announceFailure()
        }
    }

    private func verify() {
        focus = nil
        Task {
            await model.verify()
            announceFailure()
        }
    }

    private func resend() {
        Task {
            await model.resend()
            announceFailure()
        }
    }

    private func announceFailure() {
        if let message = model.errorMessage(at: .now) {
            CentyHaptics.error()
            UIAccessibility.post(notification: .announcement, argument: message)
        } else if model.step == .code || model.step == .pending {
            CentyHaptics.success()
        }
    }
}
