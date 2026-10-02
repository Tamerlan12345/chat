import XCTest
@testable import CentyChat

/// Store-review metadata is checked against the files actually bundled into the app,
/// not against the sources, so a build-setting regression cannot hide a missing key.
final class BundleMetadataTests: XCTestCase {
    private var appBundle: Bundle { Bundle(for: AppState.self) }

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
