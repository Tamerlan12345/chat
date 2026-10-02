import SwiftUI
import UIKit

/// The app's front door: brand lockup, company name and one card with login and password.
///
/// There is no server field and no way to change the server: the build is fixed to one
/// (`ServerEnvironment`). The password stays in memory only (`LoginFormModel`).
public struct LoginView: View {
    private enum Field: Hashable {
        case username
        case password
    }

    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var form = LoginFormModel()
    @State private var isPasswordVisible = false
    @State private var isMarkVisible = false
    @FocusState private var focusedField: Field?
    @ScaledMetric(relativeTo: .largeTitle) private var markSize: CGFloat = 72

    /// The mark animates in once per app launch.
    @MainActor private static var hasPresentedMark = false

    public init() {}

    public var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                lockup
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    card(at: context.date)
                }
                Text("Забыли пароль? Обратитесь к администратору.")
                    .font(.footnote)
                    .foregroundStyle(CentyColors.textDim)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, 20)
            .padding(.top, 48)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("login-screen")
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollBounceBehavior(.basedOnSize)
        .background(CentyColors.canvas.ignoresSafeArea())
        .onAppear {
            form.prefill(username: session.savedUsername)
            presentMark()
        }
    }

    // MARK: - Brand

    private var lockup: some View {
        VStack(spacing: 14) {
            BrandMark(size: min(markSize, 120))
                .scaleEffect(isMarkVisible ? 1 : 0.86)
                .opacity(isMarkVisible ? 1 : 0)
            VStack(spacing: 6) {
                BrandWordmark()
                // Plain text from /api/settings/info, sanitised and length-capped.
                Text(BrandCopy.companyLine(session.companyName))
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("login-company")
            }
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { focusedField = nil }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("login-brand")
    }

    private func presentMark() {
        guard !isMarkVisible else { return }
        if reduceMotion || Self.hasPresentedMark {
            isMarkVisible = true
        } else {
            withAnimation(.spring(response: 0.5, dampingFraction: 0.82)) {
                isMarkVisible = true
            }
        }
        Self.hasPresentedMark = true
    }

    // MARK: - Card

    private func card(at date: Date) -> some View {
        let message = form.errorMessage(at: date)
        let canSubmit = form.canSubmit(at: date)
        return VStack(alignment: .leading, spacing: 16) {
            if let message {
                LoginErrorBox(message: message)
                    .transition(.opacity)
            }

            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Логин")
                TextField("Корпоративный логин", text: $form.username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focusedField, equals: .username)
                    .onSubmit { focusedField = .password }
                    .modifier(LoginFieldStyle(isFocused: focusedField == .username))
                    .accessibilityLabel("Логин")
                    .accessibilityIdentifier("login-username")
            }

            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Пароль")
                HStack(spacing: 0) {
                    passwordField
                    Button {
                        isPasswordVisible.toggle()
                        focusedField = .password
                    } label: {
                        Image(systemName: isPasswordVisible ? "eye.slash" : "eye")
                            .foregroundStyle(CentyColors.textDim)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(isPasswordVisible ? "Скрыть пароль" : "Показать пароль")
                    .accessibilityIdentifier("login-password-visibility")
                }
                .modifier(LoginFieldStyle(isFocused: focusedField == .password, trailingPadding: 0))
            }

            Button(action: submit) {
                ZStack {
                    Text("Войти")
                        .opacity(form.isSubmitting ? 0 : 1)
                    HStack(spacing: 8) {
                        ProgressView()
                            .tint(CentyColors.onPrimary)
                        Text("Вход…")
                    }
                    .opacity(form.isSubmitting ? 1 : 0)
                    .accessibilityHidden(!form.isSubmitting)
                }
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 48)
            }
            .buttonStyle(LoginPrimaryButtonStyle(isBusy: form.isSubmitting, reduceMotion: reduceMotion))
            .disabled(!canSubmit)
            .accessibilityLabel(form.isSubmitting ? "Выполняется вход" : "Войти")
            .accessibilityIdentifier("login-submit")
            .padding(.top, 4)
        }
        .disabled(form.isSubmitting)
        .opacity(form.isSubmitting ? 0.92 : 1)
        .animation(.easeOut(duration: 0.18), value: form.isSubmitting)
        .animation(.easeOut(duration: 0.18), value: message)
        .padding(20)
        .background(CentyColors.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(CentyColors.border, lineWidth: 1)
        }
    }

    @ViewBuilder
    private var passwordField: some View {
        Group {
            if isPasswordVisible {
                TextField("Пароль", text: $form.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } else {
                SecureField("Пароль", text: $form.password)
            }
        }
        .textContentType(.password)
        .submitLabel(.go)
        .focused($focusedField, equals: .password)
        .onSubmit(submit)
        .privacySensitive()
        .accessibilityLabel("Пароль")
        .accessibilityIdentifier("login-password")
    }

    private func fieldLabel(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(CentyColors.textSecondary)
            .accessibilityHidden(true)
    }

    // MARK: - Actions

    private func submit() {
        guard form.canSubmit(at: .now) else { return }
        focusedField = nil
        Task {
            let outcome = await form.submit { username, password in
                try await session.login(username: username, password: password)
            }
            switch outcome {
            case .authenticated:
                CentyHaptics.success()
            case .passwordChangeRequired:
                CentyHaptics.warning()
            case nil:
                CentyHaptics.error()
                if let message = form.errorMessage(at: .now) {
                    UIAccessibility.post(notification: .announcement, argument: message)
                }
            }
        }
    }
}

/// Error box styled like desktop `.login-error-box`: danger-soft fill, danger hairline.
private struct LoginErrorBox: View {
    let message: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
                .accessibilityHidden(true)
            Text(message)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.numericText())
        }
        .font(.footnote)
        .foregroundStyle(CentyColors.dangerText)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CentyColors.dangerSoft, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(CentyColors.dangerLine, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("login-error")
    }
}

private struct LoginFieldStyle: ViewModifier {
    let isFocused: Bool
    var trailingPadding: CGFloat = 12

    func body(content: Content) -> some View {
        content
            .font(.body)
            .foregroundStyle(CentyColors.textMain)
            .padding(.leading, 12)
            .padding(.trailing, trailingPadding)
            .frame(minHeight: 48)
            .background(CentyColors.fieldBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(isFocused ? CentyColors.primaryBlue : CentyColors.border, lineWidth: isFocused ? 1.5 : 1)
            }
    }
}

private struct LoginPrimaryButtonStyle: ButtonStyle {
    /// A request is in flight: the button shows progress at full strength, not as disabled.
    let isBusy: Bool
    let reduceMotion: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(CentyColors.onPrimary)
            .background(
                configuration.isPressed ? CentyColors.primaryPressed : CentyColors.primaryBlue,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .opacity(isEnabled || isBusy ? 1 : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
