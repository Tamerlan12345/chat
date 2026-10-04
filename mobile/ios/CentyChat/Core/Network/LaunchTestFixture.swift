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

    /// UI tests must not meet the system «Save Password?» sheet: password fields then carry a
    /// content type that never offers or saves credentials.
    static var suppressesPasswordAutofill: Bool { isUITestProcess }

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
    static let shouldResetSecureState = false
    static let allowsInsecureLoopback = false
    static let suppressesPasswordAutofill = false
#endif
}
