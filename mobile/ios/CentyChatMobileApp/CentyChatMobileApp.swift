import SwiftUI

/// The executable application target compiles the shared source tree directly.
/// The legacy SwiftPM entry point remains excluded from this target.
@main
struct CentyChatMobileApp: App {
    @UIApplicationDelegateAdaptor(CentyAppDelegate.self) private var appDelegate
    @State private var container: AppContainer

    init() {
#if DEBUG
        if LaunchTestFixture.shouldResetSecureState {
            try? KeychainManager.shared.resetForUITesting()
            // A fresh install: no queue, no waiting files of an earlier run.
            try? SwiftDataDeliveryStore.removeFiles(at: SwiftDataDeliveryStore.defaultDirectory())
            try? AttachmentFiles(root: AttachmentFiles.defaultRoot()).removeAll()
        }
#endif
        let container = AppContainer.live()
        PushRouter.shared.notifications = container.notifications
        PushRouter.shared.pushTokens = container.pushTokens
        _container = State(initialValue: container)
    }

    var body: some Scene {
        WindowGroup {
#if DEBUG
            if LaunchTestFixture.isUnitTestHost {
                // Unit tests build their own stores; the host app stays idle and offline.
                Color.clear
            } else {
                RootView()
                    .appEnvironment(container)
                    .preferredColorScheme(LaunchTestFixture.forcedColorScheme)
            }
#else
            RootView()
                .appEnvironment(container)
#endif
        }
    }
}
