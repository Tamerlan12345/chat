import SwiftUI

/// Экран авторизации пользователя по корпоративным учетным данным
public struct LoginView: View {
    @Environment(SessionStore.self) private var session

    @State private var usernameInput: String = ""
    @State private var passwordInput: String = ""
    @State private var isLoading: Bool = false
    @State private var errorMessage: String? = nil
    @State private var showChangePasswordModal: Bool = false

    public init() {}

    private var isFormValid: Bool {
        !usernameInput.trimmingCharacters(in: .whitespaces).isEmpty &&
        !passwordInput.isEmpty
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    // Логотип компании
                    VStack(spacing: 12) {
                        Image(systemName: "shield.checkered")
                            .font(.system(size: 60))
                            .foregroundColor(CentyColors.primaryBlue)
                            .padding(.top, 40)

                        Text("Вход в CentyChat")
                            .font(.system(size: 28, weight: .bold, design: .rounded))

                        Text(session.serverInfo.companyName)
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    // Поля ввода учетных данных
                    VStack(spacing: 14) {
                        CentyTextField(
                            placeholder: "Корпоративный логин",
                            text: $usernameInput,
                            icon: "person.fill",
                            textContentType: .username,
                            autocapitalization: .never
                        )

                        CentyTextField(
                            placeholder: "Пароль",
                            text: $passwordInput,
                            icon: "lock.fill",
                            isSecure: true,
                            textContentType: .password
                        )
                    }
                    .padding(.horizontal)

                    if let error = errorMessage {
                        Text(error)
                            .font(.footnote)
                            .foregroundColor(.red)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }

                    // Кнопка входа
                    CentyButton(
                        title: isLoading ? "Авторизация..." : "Войти",
                        icon: "arrow.right.circle.fill",
                        isLoading: isLoading,
                        isEnabled: isFormValid
                    ) {
                        Task { await performLogin() }
                    }
                    .padding(.horizontal)

                    // Информация об устройстве
                    VStack(spacing: 4) {
                        Text("Устройство: \(UIDevice.current.name)")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        Text("Сервер: \(session.serverAddress)")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                    .padding(.top, 16)
                }
            }
            .background(CentyColors.chatBackground)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: {
                        session.returnToServerSetup()
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left")
                            Text("Сервер")
                        }
                        .font(.subheadline)
                    }
                }
            }
            .onAppear {
                if let saved = session.savedUsername {
                    usernameInput = saved
                }
            }
            .sheet(isPresented: $showChangePasswordModal) {
                ChangePasswordModalView(isMandatory: true)
            }
        }
    }

    private func performLogin() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            // Device Claim для беспарольного входа (Parity Matrix Section 2) выполняет SessionStore
            let outcome = try await session.login(username: usernameInput, password: passwordInput)
            if outcome == .passwordChangeRequired {
                showChangePasswordModal = true
                CentyHaptics.warning()
            } else {
                CentyHaptics.success()
            }
        } catch {
            errorMessage = error.userMessage
            CentyHaptics.error()
        }
    }
}
