import XCTest

/// Captures review evidence (Simulator screenshots) of the login screen and, when the dev
/// stand is running, of the signed-in inbox. Screenshots are kept in the xcresult bundle;
/// CI also publishes them to the `ci/ios-screenshots` branch.
///
/// Never talks to production: the app is pointed either at the dev stand
/// (`CENTYCHAT_DEV_STAND_URL`, passed by CI as `TEST_RUNNER_CENTYCHAT_DEV_STAND_URL`) or at an
/// unreachable loopback address.
@MainActor
final class ScreenshotTourTests: XCTestCase {
    private static let unreachableServer = "https://127.0.0.1:9"
    private static let accessibilitySize = "UICTContentSizeCategoryAccessibilityXXXL"

    private var standURL: String? {
        guard let value = ProcessInfo.processInfo.environment["CENTYCHAT_DEV_STAND_URL"], !value.isEmpty else {
            return nil
        }
        return value
    }

    func testLoginInLightAppearance() {
        runLoginTour(appearance: .light, suffix: "light")
    }

    func testLoginInDarkAppearance() {
        runLoginTour(appearance: .dark, suffix: "dark")
    }

    func testLoginWithAccessibilityTextSize() {
        runLoginTour(appearance: .light, suffix: "ax-xxxl", contentSize: Self.accessibilitySize)
    }

    func testSignedInInboxAsAlice() throws {
        guard let standURL else {
            throw XCTSkip("The dev stand is not running (CENTYCHAT_DEV_STAND_URL is not set).")
        }
        continueAfterFailure = false
        defer { XCUIDevice.shared.appearance = .light }
        for (appearance, suffix) in [(XCUIDevice.Appearance.light, "light"), (.dark, "dark")] {
            let application = launchFreshInstall(server: standURL, appearance: appearance)
            XCTAssertTrue(loginScreen(of: application).waitForExistence(timeout: 15), "Login must open first.")
            signIn(application, username: "alice", password: "Alice-Dev-Stand-5271")

            XCTAssertTrue(
                application.tabBars.firstMatch.waitForExistence(timeout: 30),
                "Alice must reach the signed-in tabs."
            )
            XCTAssertTrue(
                application.staticTexts["Боб Тестов"].waitForExistence(timeout: 30),
                "The seeded dialog with Bob must load from the stand."
            )
            capture(application, named: "03-inbox-alice-\(suffix)")
            application.terminate()
        }
    }

    // MARK: - Tour

    private func runLoginTour(appearance: XCUIDevice.Appearance, suffix: String, contentSize: String? = nil) {
        continueAfterFailure = false
        defer { XCUIDevice.shared.appearance = .light }
        let server = standURL ?? Self.unreachableServer
        let application = launchFreshInstall(server: server, appearance: appearance, contentSize: contentSize)

        XCTAssertTrue(loginScreen(of: application).waitForExistence(timeout: 15), "A fresh install must open on login.")
        if standURL != nil {
            // The company name comes from the stand's /api/settings/info.
            _ = application.staticTexts["login-company"].waitForExistence(timeout: 5)
        }
        let submit = application.buttons["login-submit"]
        XCTAssertTrue(submit.exists)
        XCTAssertFalse(submit.isEnabled, "«Войти» stays disabled until both fields are filled.")
        waitForAnimations()
        capture(application, named: "01-login-\(suffix)")

        // A login that does not exist on the stand: the answer must be generic.
        signIn(application, username: "qa.screenshots.\(suffix)", password: "Wrong-Password-1")
        let error = application.descendants(matching: .any)["login-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 30), "A failed login must show the error box.")
        if standURL != nil {
            XCTAssertEqual(error.label, "Неверный логин или пароль")
        }
        dismissKeyboard(application)
        capture(application, named: "02-login-error-\(suffix)")
        application.terminate()
    }

    // MARK: - Helpers

    private func launchFreshInstall(
        server: String,
        appearance: XCUIDevice.Appearance,
        contentSize: String? = nil
    ) -> XCUIApplication {
        XCUIDevice.shared.appearance = appearance
        let application = XCUIApplication()
        application.launchEnvironment["CENTYCHAT_UI_TESTING"] = "1"
        application.launchArguments += [
            "-reset-secure-state",
            "-centychat-server-url", server,
            "-centychat-color-scheme", appearance == .dark ? "dark" : "light",
        ]
        if let contentSize {
            application.launchArguments += ["-UIPreferredContentSizeCategoryName", contentSize]
        }
        application.launch()
        return application
    }

    private func loginScreen(of application: XCUIApplication) -> XCUIElement {
        application.descendants(matching: .any)["login-screen"]
    }

    private func signIn(_ application: XCUIApplication, username: String, password: String) {
        let usernameField = application.textFields["login-username"]
        XCTAssertTrue(usernameField.waitForExistence(timeout: 5))
        type(username, into: usernameField, of: application)

        let passwordField = application.secureTextFields["login-password"]
        XCTAssertTrue(passwordField.waitForExistence(timeout: 5))
        type(password, into: passwordField, of: application)

        let submit = application.buttons["login-submit"]
        XCTAssertTrue(submit.isEnabled, "«Войти» must enable once both fields are filled.")
        submit.tap()
    }

    /// Focuses the field and waits for the keyboard before typing; typing right after a tap
    /// intermittently fails with "Neither element nor any descendant has keyboard focus".
    private func type(_ text: String, into field: XCUIElement, of application: XCUIApplication) {
        for _ in 0..<3 {
            field.tap()
            if application.keyboards.firstMatch.waitForExistence(timeout: 3) {
                break
            }
        }
        XCTAssertTrue(application.keyboards.firstMatch.exists, "The field must receive keyboard focus")
        field.typeText(text)
    }

    private func dismissKeyboard(_ application: XCUIApplication) {
        guard application.keyboards.firstMatch.exists else { return }
        application.descendants(matching: .any)["login-brand"].tap()
        _ = application.keyboards.firstMatch.waitForNonExistence(timeout: 3)
    }

    /// Lets the one-time mark animation and field transitions finish before a screenshot.
    private func waitForAnimations() {
        RunLoop.current.run(until: Date().addingTimeInterval(1))
    }

    private func capture(_ application: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: application.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
