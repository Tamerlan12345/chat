import SwiftUI

@main
public struct CentyChatApp: App {
    @State private var appState = AppState()
    
    public init() {}
    
    public var body: some Scene {
        WindowGroup {
            Group {
                if !appState.isServerConfigured {
                    ServerConnectView()
                } else if !appState.isAuthenticated {
                    LoginView()
                } else {
                    MainTabView()
                }
            }
            .environment(appState)
            .task {
                await appState.initialize()
            }
            // Полноэкранный вызов (VoIP Call)
            .fullScreenCover(isPresented: Binding(
                get: { appState.activeCall != nil },
                set: { if !$0 { appState.stopCallSession() } }
            )) {
                CallView()
                    .environment(appState)
            }
            // Обязательная смена пароля
            .sheet(isPresented: Binding(
                get: { appState.mustChangePasswordRequired },
                set: { _ in }
            )) {
                ChangePasswordModalView(isMandatory: true)
                    .environment(appState)
            }
            // Оповещение побудки (Wake Buzzer)
            .alert(
                "Побудка",
                isPresented: Binding(
                    get: { appState.incomingWakeAlert != nil },
                    set: { if !$0 { appState.incomingWakeAlert = nil } }
                )
            ) {
                Button("Ответить", role: .cancel) {
                    appState.incomingWakeAlert = nil
                }
            } message: {
                if let msg = appState.incomingWakeAlert {
                    Text(msg)
                }
            }
            // Ошибки
            .alert(
                "Ошибка",
                isPresented: Binding(
                    get: { appState.errorMessage != nil },
                    set: { if !$0 { appState.errorMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) {
                    appState.errorMessage = nil
                }
            } message: {
                if let err = appState.errorMessage {
                    Text(err)
                }
            }
        }
    }
}
