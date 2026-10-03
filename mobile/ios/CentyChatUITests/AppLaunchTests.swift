import XCTest

final class AppLaunchTests: XCTestCase {
    /// The server is fixed at build time: a fresh install opens straight on login, with
    /// no server setup and no way to change the server.
    func testFreshInstallShowsLogin() async {
        await MainActor.run {
            let application = XCUIApplication()
            application.launchEnvironment["CENTYCHAT_UI_TESTING"] = "1"
            // Never production from tests: an unreachable loopback server is enough here.
            application.launchArguments += ["-reset-secure-state", "-centychat-server-url", "https://127.0.0.1:9"]
            application.launch()

            XCTAssertTrue(
                application.descendants(matching: .any)["login-screen"].waitForExistence(timeout: 10),
                "A fresh install must open on login."
            )
            XCTAssertFalse(application.otherElements["server-setup"].exists, "Server setup was removed.")
            XCTAssertFalse(
                application.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Сервер")).firstMatch.exists,
                "Login must not offer a way to change the server."
            )
            XCTAssertFalse(application.textFields.matching(NSPredicate(format: "placeholderValue CONTAINS %@", "https")).firstMatch.exists)
        }
    }
}
