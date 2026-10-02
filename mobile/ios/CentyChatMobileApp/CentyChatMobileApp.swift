import SwiftUI

/// The executable application target compiles the shared source tree directly.
/// The legacy SwiftPM entry point remains excluded from this target.
@main
struct CentyChatMobileApp: App {
    @State private var container: AppContainer

    init() {
#if DEBUG
        if LaunchTestFixture.shouldResetSecureState {
            try? KeychainManager.shared.resetForUITesting()
        }
#endif
        _container = State(initialValue: AppContainer.live())
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .appEnvironment(container)
        }
    }
}
