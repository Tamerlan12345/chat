import XCTest
@testable import CentyChat

/// Store-review metadata is checked against the files actually bundled into the app,
/// not against the sources, so a build-setting regression cannot hide a missing key.
final class BundleMetadataTests: XCTestCase {
    private var appBundle: Bundle { Bundle(for: AppContainer.self) }

    func testPrivacyManifestDeclaresSystemBootTimeWithElapsedTimeReason() throws {
        let manifest = try bundledPropertyList(named: "PrivacyInfo", extension: "xcprivacy")
        let accessedAPITypes = try XCTUnwrap(
            manifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]],
            "The privacy manifest must list NSPrivacyAccessedAPITypes."
        )
        let systemBootTime = try XCTUnwrap(
            accessedAPITypes.first {
                $0["NSPrivacyAccessedAPIType"] as? String == "NSPrivacyAccessedAPICategorySystemBootTime"
            },
            "Audio playback scheduling reads system uptime, so SystemBootTime must be declared."
        )
        XCTAssertEqual(systemBootTime["NSPrivacyAccessedAPITypeReasons"] as? [String], ["35F9.1"])
    }

    func testPrivacyManifestKeepsTrackingDisabled() throws {
        let manifest = try bundledPropertyList(named: "PrivacyInfo", extension: "xcprivacy")
        XCTAssertEqual(manifest["NSPrivacyTracking"] as? Bool, false)
    }

    func testInfoPlistDoesNotRequire32BitArchitecture() throws {
        let info = try bundledPropertyList(named: "Info", extension: "plist")
        let capabilities = info["UIRequiredDeviceCapabilities"] as? [String] ?? []
        XCTAssertFalse(capabilities.contains("armv7"), "armv7 blocks installation on every 64-bit-only device.")
    }

    func testInfoPlistSupportsEveryIPadOrientationForMultitasking() throws {
        let info = try bundledPropertyList(named: "Info", extension: "plist")
        let iPadOrientations = try XCTUnwrap(
            info["UISupportedInterfaceOrientations~ipad"] as? [String],
            "iPad multitasking requires an explicit iPad orientation list."
        )
        XCTAssertEqual(
            Set(iPadOrientations),
            [
                "UIInterfaceOrientationPortrait",
                "UIInterfaceOrientationPortraitUpsideDown",
                "UIInterfaceOrientationLandscapeLeft",
                "UIInterfaceOrientationLandscapeRight",
            ]
        )
        XCTAssertNil(info["UIRequiresFullScreen"], "Full-screen mode opts the app out of iPad multitasking.")
    }

    // MARK: - Fix wave (final review I3, I4, M5, M7, M8; parity §4.2)

    /// App Store Connect rejects an upload that reads UserDefaults (search recents) or file
    /// attributes (attachment sizes) without a declared reason (ITMS-91053).
    func testPrivacyManifestDeclaresUserDefaultsAndFileTimestamps() throws {
        let manifest = try bundledPropertyList(named: "PrivacyInfo", extension: "xcprivacy")
        let types = try XCTUnwrap(manifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        func reasons(_ category: String) -> [String]? {
            types.first { $0["NSPrivacyAccessedAPIType"] as? String == category }?["NSPrivacyAccessedAPITypeReasons"] as? [String]
        }
        XCTAssertEqual(reasons("NSPrivacyAccessedAPICategoryUserDefaults"), ["CA92.1"])
        XCTAssertEqual(reasons("NSPrivacyAccessedAPICategoryFileTimestamp"), ["C617.1"])
    }

    /// Silent `read` pushes wake the app (`remote-notification`); the outbox goes out in the
    /// background (`fetch` + the BGTask identifier); calls keep `audio`.
    func testBackgroundModesCoverPushesAndTheBackgroundFlush() throws {
        let info = try bundledPropertyList(named: "Info", extension: "plist")
        let modes = Set(info["UIBackgroundModes"] as? [String] ?? [])
        XCTAssertTrue(modes.isSuperset(of: ["audio", "remote-notification", "fetch"]), "\(modes)")
        let identifiers = info["BGTaskSchedulerPermittedIdentifiers"] as? [String] ?? []
        XCTAssertEqual(identifiers, [DeliveryBackgroundTask.identifier])
    }

    /// Export compliance is answered in the build; no permission text for an API the app never uses
    /// (it has no camera and reads no photo library: PhotosPicker needs no permission).
    func testInfoPlistIsReadyForAppReview() throws {
        let info = try bundledPropertyList(named: "Info", extension: "plist")
        XCTAssertEqual(info["ITSAppUsesNonExemptEncryption"] as? Bool, false)
        XCTAssertNil(info["NSCameraUsageDescription"])
        XCTAssertNil(info["NSPhotoLibraryUsageDescription"])
        XCTAssertNotNil(info["NSMicrophoneUsageDescription"], "calls need the microphone")
    }

    /// The build number comes from the build settings, so it can be raised for every upload.
    func testTheBuildNumberComesFromTheBuildSettings() throws {
        let source = try sourceFile("CentyChat/Resources/Info.plist")
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(source.utf8), format: nil) as? [String: Any])
        XCTAssertEqual(plist["CFBundleVersion"] as? String, "$(CURRENT_PROJECT_VERSION)")
        XCTAssertEqual(plist["CFBundleShortVersionString"] as? String, "$(MARKETING_VERSION)")
    }

    /// App Store Connect refuses an icon with an alpha channel (ITMS-90717): the PNG must be RGB.
    func testTheAppIconHasNoAlphaChannel() throws {
        let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let icon = try Data(contentsOf: tests.appendingPathComponent("../CentyChat/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png").standardizedFileURL)
        XCTAssertEqual(Array(icon.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "a PNG")
        // IHDR: width, height, bit depth, colour type (byte 25): 2 — RGB, 6 — RGBA.
        XCTAssertEqual(icon[25], 2, "colour type must be RGB without alpha")
    }

    /// Every Debug-only hook is named in the Release lock, so a regression that compiles one into
    /// Release fails CI (final review M5).
    func testTheReleaseLockScriptChecksEveryTestHook() throws {
        let script = try sourceFile("scripts/verify-release-server-lock.sh")
        for hook in ["-centychat-stub-account", "CENTYCHAT_STUB_SIGNIN", "-allow-insecure-loopback", "UITestAccountRepository", "-centychat-server-url", "CENTYCHAT_UI_TESTING"] {
            XCTAssertTrue(script.contains("\"\(hook)\""), "verify-release-server-lock.sh must forbid \(hook)")
        }
    }

    /// The entitlements template the owner signs with (decision P): APNs, nothing else.
    func testTheEntitlementsTemplateAsksOnlyForPush() throws {
        let template = try sourceFile("Signing/CentyChat.entitlements")
        let data = Data(template.utf8)
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        XCTAssertEqual(Set(plist.keys), ["aps-environment"])
        XCTAssertEqual(plist["aps-environment"] as? String, "development", "Xcode rewrites it to production when exporting for the store")
    }

    /// A file of `mobile/ios` as checked in (the simulator reads the checkout).
    private func sourceFile(_ path: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }

    private func bundledPropertyList(named name: String, extension fileExtension: String) throws -> [String: Any] {
        let url = try XCTUnwrap(
            appBundle.url(forResource: name, withExtension: fileExtension),
            "\(name).\(fileExtension) must be bundled in the app."
        )
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        )
    }
}
