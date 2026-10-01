import Foundation

enum LaunchTestFixture {
#if DEBUG
    private static var isUITestProcess: Bool {
        ProcessInfo.processInfo.environment["CENTYCHAT_UI_TESTING"] == "1"
    }

    static var shouldResetSecureState: Bool {
        isUITestProcess && ProcessInfo.processInfo.arguments.contains("-reset-secure-state")
    }

    static var allowsInsecureLoopback: Bool {
        isUITestProcess && ProcessInfo.processInfo.arguments.contains("-allow-insecure-loopback")
    }
#else
    static let shouldResetSecureState = false
    static let allowsInsecureLoopback = false
#endif
}
