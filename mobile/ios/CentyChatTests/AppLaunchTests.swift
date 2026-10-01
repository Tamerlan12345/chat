import XCTest

final class AppLaunchTests: XCTestCase {
    func testFreshInstallShowsServerSetup() async {
        await MainActor.run {
            let application = XCUIApplication()
            application.launchEnvironment["CENTYCHAT_UI_TESTING"] = "1"
            application.launchArguments += ["-reset-secure-state"]
            application.launch()

            XCTAssertTrue(
                application.otherElements["server-setup"].waitForExistence(timeout: 5),
                "A fresh install must present server setup before authentication."
            )
        }
    }
}
