import SwiftUI

/// Экран авторизации пользователя по корпоративным учетным данным
public struct LoginView: View {
    @Environment(AppState.self) private var appState
    
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
                        
                        Text(appState.serverInfo.companyName)
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
                        Text("Сервер: \(KeychainManager.shared.serverUrl)")
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
                        appState.isServerConfigured = false
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
                if let saved = KeychainManager.shared.savedUsername {
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
        
        let cleanedUsername = usernameInput.trimmingCharacters(in: .whitespaces).lowercased()
        
        do {
            let req = LoginRequest(username: cleanedUsername, password: passwordInput)
            let res = try await APIClient.shared.login(request: req)
            
            KeychainManager.shared.savedUsername = cleanedUsername
            appState.currentUser = res.user
            
            // Device Claim для беспарольного входа (Parity Matrix Section 2)
            let secret = generateDeviceSecret()
            let deviceId = KeychainManager.shared.deviceId
            let claimed = try? await APIClient.shared.claimDevice(deviceId: deviceId, deviceSecret: secret)
            if claimed == true {
                KeychainManager.shared.deviceSecret = secret
            }
            
            // Подключение WebSocket
            await WebSocketClient.shared.connect()
            
            // Проверка обязательной смены пароля
            if res.user.mustChangePassword {
                appState.mustChangePasswordRequired = true
                showChangePasswordModal = true
            } else {
                appState.isAuthenticated = true
                await appState.loadAllData()
            }
            
            CentyHaptics.success()
        } catch APIError.mustChangePassword(let msg) {
            appState.mustChangePasswordRequired = true
            showChangePasswordModal = true
            errorMessage = msg
            CentyHaptics.warning()
        } catch {
            errorMessage = error.localizedDescription
            CentyHaptics.error()
        }
    }
    
    private func generateDeviceSecret() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
