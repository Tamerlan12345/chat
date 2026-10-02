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
            case .launching:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(CentyColors.chatBackground)
                    .accessibilityLabel("Загрузка")
            case .serverSetup:
                ServerConnectView()
                    .accessibilityIdentifier("server-setup")
            case .signedOut:
                LoginView()
            case .passwordChangeRequired:
                // The only presentation of the mandatory change: a root screen, not a sheet.
                ChangePasswordModalView(isMandatory: true)
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
