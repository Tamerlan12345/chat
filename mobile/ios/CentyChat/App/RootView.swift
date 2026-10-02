import SwiftUI

/// Chooses the top-level screen from the session phase and hosts app-wide presentations.
public struct RootView: View {
    @Environment(AppContainer.self) private var container

    public init() {}

    public var body: some View {
        let session = container.session
        let calls = container.calls
        let profile = container.profile

        Group {
            switch session.phase {
            case .serverSetup:
                ServerConnectView()
                    .accessibilityIdentifier("server-setup")
            case .signedOut, .passwordChangeRequired:
                LoginView()
            case .authenticated:
                MainTabView()
            }
        }
        .task {
            await session.bootstrap()
        }
        .fullScreenCover(isPresented: Binding(
            get: { calls.activeCall != nil },
            set: { if !$0 { calls.stopCallSession() } }
        )) {
            CallView()
                .appEnvironment(container)
        }
        .sheet(isPresented: Binding(
            get: { session.mustChangePasswordRequired },
            set: { _ in }
        )) {
            ChangePasswordModalView(isMandatory: true)
                .appEnvironment(container)
        }
        .alert(
            "Сигнал от коллеги",
            isPresented: Binding(
                get: { profile.incomingWakeAlert != nil },
                set: { if !$0 { profile.incomingWakeAlert = nil } }
            )
        ) {
            Button("Закрыть", role: .cancel) {
                profile.incomingWakeAlert = nil
            }
        } message: {
            if let message = profile.incomingWakeAlert {
                Text(message)
            }
        }
        .alert(
            "Ошибка",
            isPresented: Binding(
                get: { session.errorMessage != nil },
                set: { if !$0 { session.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {
                session.errorMessage = nil
            }
        } message: {
            if let message = session.errorMessage {
                Text(message)
            }
        }
    }
}
