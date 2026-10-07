import Foundation
import SwiftUI

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

    /// UI tests that cannot reach a real mail server: registration, reports, blocks and account
    /// deletion are answered by `UITestAccountRepository` (`-centychat-stub-account`).
    static var stubsAccountBackend: Bool {
        isUITestProcess && ProcessInfo.processInfo.arguments.contains("-centychat-stub-account")
    }

    /// UI tests of the offline queue (`-centychat-ui-delivery-offline`): the message transport is
    /// down — the socket points at a closed port and the delivery HTTP requests fail as without a
    /// network — while sign-in and history still load. Never changes the stand.
    static var deliveryOffline: Bool {
        isUITestProcess && ProcessInfo.processInfo.arguments.contains("-centychat-ui-delivery-offline")
    }

    /// UI tests of the design review (`-centychat-ui-gallery`): the component gallery instead of the
    /// app, with canned data and no network.
    static var showsDesignGallery: Bool {
        isUITestProcess && ProcessInfo.processInfo.arguments.contains("-centychat-ui-gallery")
    }

    /// UI tests read the chat's scroll geometry from a tiny accessibility label (diagnostics of
    /// «opens at the newest message»).
    static var exposesScrollProbe: Bool { isUITestProcess }

    /// Where the socket connects instead of the server while `deliveryOffline` (nothing listens).
    static var realtimeServerOverride: String? {
        deliveryOffline ? "https://127.0.0.1:9" : nil
    }

    /// UI tests must not meet the system «Save Password?» sheet: password fields then carry a
    /// content type that never offers or saves credentials.
    static var suppressesPasswordAutofill: Bool { isUITestProcess }

    /// UI tests never meet the system notification question (decision P asks it after sign-in).
    static var suppressesNotificationPrompt: Bool { isUITestProcess }

    /// The app is hosting XCTest unit tests (not a UI test launch).
    static var isUnitTestHost: Bool {
        let environment = ProcessInfo.processInfo.environment
        let hostsXCTest = environment["XCTestConfigurationFilePath"] != nil
            || environment["XCTestBundlePath"] != nil
            || environment["XCTestSessionIdentifier"] != nil
        return hostsXCTest && !isUITestProcess
    }

    /// UI tests pin the appearance (`-centychat-color-scheme dark|light`) so screenshots
    /// do not depend on the simulator's global setting.
    static var forcedColorScheme: ColorScheme? {
        guard isUITestProcess else { return nil }
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-centychat-color-scheme"),
              arguments.indices.contains(index + 1) else { return nil }
        switch arguments[index + 1] {
        case "dark": return .dark
        case "light": return .light
        default: return nil
        }
    }
#else
    static let deliveryOffline = false
    static let exposesScrollProbe = false
    static let realtimeServerOverride: String? = nil
    static let shouldResetSecureState = false
    static let allowsInsecureLoopback = false
    static let suppressesPasswordAutofill = false
    static let suppressesNotificationPrompt = false
#endif
}
