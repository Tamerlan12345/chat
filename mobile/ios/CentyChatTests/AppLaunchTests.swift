import XCTest

final class AppLaunchTests: XCTestCase {
    func testFreshInstallShowsServerSetup() {
        let application = XCUIApplication()
        application.launch()

        XCTAssertTrue(
            application.otherElements["server-setup"].waitForExistence(timeout: 5),
            "A fresh install must present server setup before authentication."
        )
    }
}
