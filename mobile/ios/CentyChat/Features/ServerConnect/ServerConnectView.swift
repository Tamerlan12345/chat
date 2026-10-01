import SwiftUI

/// Экран настройки и проверки адреса корпоративного сервера CentyChat
public struct ServerConnectView: View {
    @Environment(AppState.self) private var appState
    
    @State private var serverUrlInput: String = ""
    @State private var isChecking: Bool = false
    @State private var checkSuccess: Bool = false
    @State private var serverDetails: ServerInfo? = nil
    @State private var errorMessage: String? = nil
    
    public init() {}
    
    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    // Логотип и заголовок CentyChat
                    VStack(spacing: 12) {
                        Image(systemName: "bubble.left.and.bubble.right.fill")
                            .font(.system(size: 64))
                            .foregroundColor(CentyColors.primaryBlue)
                            .padding(.top, 40)
                        
                        Text("CentyChat")
                            .font(.system(size: 32, weight: .bold, design: .rounded))
                        
                        Text("Корпоративный защищённый мессенджер\nАО СК «Сентрас Иншуранс»")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    
                    // Форма ввода URL
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Адрес сервера компании")
                            .font(.footnote.weight(.semibold))
                            .foregroundColor(.secondary)
                        
                        CentyTextField(
                            placeholder: "https://chat.example.com",
                            text: $serverUrlInput,
                            icon: "server.rack",
                            keyboardType: .URL
                        )
                        
                        if let error = errorMessage {
                            Text(error)
                                .font(.caption)
                                .foregroundColor(.red)
                        }
                    }
                    .padding(.horizontal)
                    
                    // Кнопка проверки доступности
                    CentyButton(
                        title: isChecking ? "Проверка связи..." : "Проверить подключение",
                        icon: "antenna.radiowaves.left.and.right",
                        isLoading: isChecking,
                        isEnabled: !serverUrlInput.trimmingCharacters(in: .whitespaces).isEmpty
                    ) {
                        Task { await checkConnection() }
                    }
                    .padding(.horizontal)
                    
                    // Карточка успешного подключения
                    if let details = serverDetails, checkSuccess {
                        VStack(spacing: 8) {
                            HStack {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(.green)
                                Text("Сервер доступен")
                                    .font(.headline)
                            }
                            
                            Text(details.serverName)
                                .font(.subheadline.weight(.semibold))
                            
                            Text(details.companyName)
                                .font(.caption)
                                .foregroundColor(.secondary)
                            
                            CentyButton(
                                title: "Перейти ко входу",
                                icon: "arrow.right"
                            ) {
                                do {
                                    try KeychainManager.shared.saveServerURL(
                                        serverUrlInput.trimmingCharacters(in: .whitespaces)
                                    )
                                    appState.serverInfo = details
                                    appState.isServerConfigured = true
                                } catch {
                                    errorMessage = error.localizedDescription
                                    CentyHaptics.error()
                                }
                            }
                            .padding(.top, 8)
                        }
                        .padding()
                        .frame(maxWidth: .infinity)
                        .background(Color(uiColor: .secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .padding(.horizontal)
                    }
                }
            }
            .background(CentyColors.chatBackground)
            .navigationTitle("Подключение")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                serverUrlInput = KeychainManager.shared.serverUrl
            }
        }
    }
    
    private func checkConnection() async {
        isChecking = true
        errorMessage = nil
        checkSuccess = false
        serverDetails = nil
        defer { isChecking = false }
        
        let cleaned = serverUrlInput.trimmingCharacters(in: .whitespaces)
        guard let serverURL = ServerEndpointPolicy.configuredURL(from: cleaned) else {
            errorMessage = "Введите корректный URL (например, https://chat.example.com)"
            CentyHaptics.error()
            return
        }
        
        do {
            let health = try await APIClient.shared.checkHealth(serverURL: serverURL)
            guard health.isHealthy else {
                errorMessage = "Сервер ответил статусом: \(health.status)"
                CentyHaptics.warning()
                return
            }
            
            let info = try await APIClient.shared.getServerInfo(serverURL: serverURL)
            serverDetails = info
            checkSuccess = true
            CentyHaptics.success()
        } catch {
            errorMessage = "Не удалось подключиться: \(error.localizedDescription)"
            CentyHaptics.error()
        }
    }
}
