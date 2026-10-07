import SwiftUI

/// Chooses the top-level screen from the session phase and hosts app-wide presentations.
public struct RootView: View {
    @Environment(AppContainer.self) private var container

    public init() {}

    public var body: some View {
#if DEBUG
        if LaunchTestFixture.showsDesignGallery {
            // Design review screenshots: canned data only, the session never starts.
            DesignGalleryView()
        } else {
            SessionRootView()
        }
#else
        SessionRootView()
#endif
    }
}

private struct SessionRootView: View {
    @Environment(AppContainer.self) private var container
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let session = container.session
        let calls = container.calls
        let profile = container.profile

        Group {
            switch session.phase {
            case .launching:
                // A blank canvas for the moment the stored session is checked (no spinner).
                CentyColors.canvas
                    .ignoresSafeArea()
                    .accessibilityLabel("Загрузка")
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
            container.startNetworkWatcher()
            await session.bootstrap()
        }
        // App on screen — «В сети», in the background — «Отошёл»; .inactive is transient.
        .onChange(of: scenePhase, initial: true) { _, phase in
            switch phase {
            case .active:
                container.presence.sceneDidBecomeActive()
                // Without a background task, the queue goes out when the app comes back.
                Task { await container.appBecameActive() }
            case .background:
                container.presence.sceneDidEnterBackground()
                // What still waits goes out in a background refresh (`delivery-state.md` §4.2).
                if session.isAuthenticated {
                    DeliveryBackgroundTask.schedule(whenUnsent: container.delivery.unsentCount)
                }
            default:
                break
            }
        }
        // The first unlock since the device started: the stored session can be read now.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
            Task { await container.protectedDataBecameAvailable() }
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
            Button("Закрыть", role: .cancel) {
                session.errorMessage = nil
            }
        } message: {
            if let message = session.errorMessage {
                Text(message)
            }
        }
    }
}
