import SwiftUI

/// The executable application target compiles the shared source tree directly.
/// The legacy SwiftPM entry point remains excluded from this target.
@main
struct CentyChatMobileApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            Group {
                if !appState.isServerConfigured {
                    ServerConnectView()
                        .accessibilityIdentifier("server-setup")
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
            .fullScreenCover(isPresented: Binding(
                get: { appState.activeCall != nil },
                set: { if !$0 { appState.stopCallSession() } }
            )) {
                CallView()
                    .environment(appState)
            }
            .sheet(isPresented: Binding(
                get: { appState.mustChangePasswordRequired },
                set: { _ in }
            )) {
                ChangePasswordModalView(isMandatory: true)
                    .environment(appState)
            }
            .alert(
                "Wake alert",
                isPresented: Binding(
                    get: { appState.incomingWakeAlert != nil },
                    set: { if !$0 { appState.incomingWakeAlert = nil } }
                )
            ) {
                Button("Dismiss", role: .cancel) {
                    appState.incomingWakeAlert = nil
                }
            } message: {
                if let message = appState.incomingWakeAlert {
                    Text(message)
                }
            }
            .alert(
                "Error",
                isPresented: Binding(
                    get: { appState.errorMessage != nil },
                    set: { if !$0 { appState.errorMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) {
                    appState.errorMessage = nil
                }
            } message: {
                if let message = appState.errorMessage {
                    Text(message)
                }
            }
        }
    }
}
