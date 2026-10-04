import XCTest

/// In-app registration and account deletion.
///
/// The dev stand has no mail server, so the app runs with `-centychat-stub-account`
/// (`UITestAccountRepository`, Debug UI-test builds only): the code is always `123456`, an
/// e-mail ending in `@allowed.test` signs in as the stand user from `CENTYCHAT_STUB_SIGNIN`,
/// any other e-mail ends as «pending». Signing in and deleting need the stand; those tests
/// skip without `CENTYCHAT_DEV_STAND_URL`, like the other signed-in tests.
@MainActor
final class RegistrationFlowUITests: XCTestCase {
    private static let unreachableServer = "https://127.0.0.1:9"
    private static let standLogin = "alice"
    private static let standPassword = "Alice-Dev-Stand-5271"
    private static let code = "123456"

    private var standURL: String? {
        guard let value = ProcessInfo.processInfo.environment["CENTYCHAT_DEV_STAND_URL"], !value.isEmpty else {
            return nil
        }
        return value
    }

    // MARK: - Registration

    func testAllowedEmailRegistersAndSignsIn() throws {
        guard let standURL else {
            throw XCTSkip("The dev stand is not running (CENTYCHAT_DEV_STAND_URL is not set).")
        }
        continueAfterFailure = false
        let application = launch(server: standURL)
        openRegistration(application)

        fillForm(application, email: "ivan@allowed.test", name: "Иван Иванов", username: "ivan.allowed")
        submitForm(application)
        XCTAssertTrue(codeField(application).waitForExistence(timeout: 10), "The code step must open")
        XCTAssertFalse(application.buttons["register-resend"].isEnabled, "A new code cannot be requested right away")
        XCTAssertFalse(application.buttons["register-verify"].isEnabled, "Verify needs six digits")

        // A wrong code first: the error shows and the step stays.
        enterCode(application, "000000")
        application.buttons["register-verify"].tap()
        XCTAssertTrue(
            application.descendants(matching: .any)["register-code-error"].waitForExistence(timeout: 10),
            "A wrong code must be explained"
        )

        enterCode(application, Self.code)
        application.buttons["register-verify"].tap()
        XCTAssertTrue(
            application.tabBars.firstMatch.waitForExistence(timeout: 30),
            "A confirmed allowed e-mail must land in the signed-in app"
        )
    }

    func testUnlistedEmailEndsWaitingForTheAdministrator() {
        continueAfterFailure = false
        let application = launch(server: Self.unreachableServer)
        openRegistration(application)

        fillForm(application, email: "petr@pending.test", name: "Пётр Петров", username: "petr.pending")
        submitForm(application)
        XCTAssertTrue(codeField(application).waitForExistence(timeout: 10))
        enterCode(application, Self.code)
        application.buttons["register-verify"].tap()

        let pending = application.descendants(matching: .any)["register-pending"]
        XCTAssertTrue(pending.waitForExistence(timeout: 10), "The pending screen must open")
        XCTAssertTrue(
            application.staticTexts["Заявка отправлена на рассмотрение администратору"].exists,
            "The pending screen must say the application waits for the administrator"
        )
        XCTAssertFalse(application.tabBars.firstMatch.exists, "A pending account has no session")

        application.buttons["register-pending-done"].tap()
        XCTAssertTrue(
            application.descendants(matching: .any)["login-screen"].waitForExistence(timeout: 10),
            "Back to login"
        )
    }

    func testMissingMailServerIsReportedHonestly() {
        continueAfterFailure = false
        let application = launch(server: Self.unreachableServer)
        openRegistration(application)

        fillForm(application, email: "mailoff@company.kz", name: "Мария Сидорова", username: "maria.mail")
        submitForm(application)

        let error = application.descendants(matching: .any)["register-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 10), "A server without mail must be reported")
        XCTAssertTrue(error.label.contains("почта не настроена"), error.label)
        XCTAssertFalse(codeField(application).exists, "No code step when no code was sent")
    }

    func testFormValidationAndAccessibilityTextSize() {
        continueAfterFailure = false
        let application = launch(
            server: Self.unreachableServer,
            appearance: "dark",
            contentSize: "UICTContentSizeCategoryAccessibilityXXXL"
        )
        openRegistration(application)

        let submit = application.buttons["register-submit"]
        scrollTo(submit, in: application)
        XCTAssertTrue(submit.exists)
        submit.tap()
        // An empty form must explain itself instead of sending anything.
        let hint = application.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "адрес эл. почты")).firstMatch
        XCTAssertTrue(hint.waitForExistence(timeout: 5), "An empty e-mail must be flagged")
        XCTAssertFalse(codeField(application).exists)
    }

    // MARK: - Account deletion

    func testDeleteAccountSignsOutAndForgetsTheSession() throws {
        guard let standURL else {
            throw XCTSkip("The dev stand is not running (CENTYCHAT_DEV_STAND_URL is not set).")
        }
        continueAfterFailure = false
        let application = launch(server: standURL)
        XCTAssertTrue(loginScreen(application).waitForExistence(timeout: 15))
        signIn(application, username: Self.standLogin, password: Self.standPassword)
        XCTAssertTrue(application.tabBars.firstMatch.waitForExistence(timeout: 30), "Alice must reach the tabs")

        application.tabBars.buttons["Профиль"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let deleteEntry = application.buttons["profile-delete-account"]
        scrollTo(deleteEntry, in: application)
        XCTAssertTrue(deleteEntry.exists, "The profile must offer account deletion")
        // The row can sit under the tab bar edge: a coordinate tap does not need it to be hittable.
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        for _ in 0..<4 where !application.buttons["delete-confirm"].exists {
            if deleteEntry.isHittable {
                deleteEntry.tap()
            } else {
                deleteEntry.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
            _ = application.buttons["delete-confirm"].waitForExistence(timeout: 4)
        }

        let passwordField = application.secureTextFields["delete-password"]
        XCTAssertTrue(passwordField.waitForExistence(timeout: 10))
        XCTAssertFalse(application.buttons["delete-confirm"].isEnabled, "Deletion needs the password")

        // A wrong password: confirmed in the alert, refused, still signed in.
        type("wrong-password", into: passwordField, of: application)
        confirmDeletionAlert(application)
        XCTAssertTrue(
            application.descendants(matching: .any)["delete-error"].waitForExistence(timeout: 10),
            "A wrong password must be refused"
        )
        XCTAssertTrue(passwordField.exists, "Still on the deletion sheet")

        // The right password deletes and signs out.
        passwordField.tap()
        passwordField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "wrong-password".count))
        passwordField.typeText(Self.standPassword)
        confirmDeletionAlert(application)
        XCTAssertTrue(loginScreen(application).waitForExistence(timeout: 30), "A deleted account must return to login")
        XCTAssertFalse(application.tabBars.firstMatch.exists)
        application.terminate()

        // Nothing is left on the device: a relaunch without resetting secure state opens on login.
        let relaunched = launch(server: standURL, resetSecureState: false)
        XCTAssertTrue(loginScreen(relaunched).waitForExistence(timeout: 20), "No session may survive the deletion")
        XCTAssertFalse(relaunched.tabBars.firstMatch.exists)
    }

    // MARK: - Helpers

    private func launch(
        server: String,
        appearance: String = "light",
        contentSize: String? = nil,
        resetSecureState: Bool = true
    ) -> XCUIApplication {
        let application = XCUIApplication()
        application.launchEnvironment["CENTYCHAT_UI_TESTING"] = "1"
        application.launchEnvironment["CENTYCHAT_STUB_SIGNIN"] = "\(Self.standLogin):\(Self.standPassword)"
        application.launchArguments += [
            "-centychat-server-url", server,
            "-centychat-color-scheme", appearance,
            "-centychat-stub-account",
        ]
        if resetSecureState {
            application.launchArguments.append("-reset-secure-state")
        }
        if let contentSize {
            application.launchArguments += ["-UIPreferredContentSizeCategoryName", contentSize]
        }
        application.launch()
        return application
    }

    private func loginScreen(_ application: XCUIApplication) -> XCUIElement {
        application.descendants(matching: .any)["login-screen"]
    }

    private func codeField(_ application: XCUIApplication) -> XCUIElement {
        application.textFields["register-code"]
    }

    private func openRegistration(_ application: XCUIApplication) {
        XCTAssertTrue(loginScreen(application).waitForExistence(timeout: 15), "A fresh install must open on login.")
        let entry = application.buttons["login-register"]
        scrollTo(entry, in: application)
        XCTAssertTrue(entry.exists, "Login must offer «Зарегистрироваться»")
        entry.tap()
        XCTAssertTrue(
            application.descendants(matching: .any)["register-form"].waitForExistence(timeout: 10),
            "The registration form must open"
        )
    }

    private func fillForm(_ application: XCUIApplication, email: String, name: String, username: String) {
        type(email, into: application.textFields["register-email"], of: application)
        type(name, into: application.textFields["register-name"], of: application)
        type(username, into: application.textFields["register-username"], of: application)
        type("Str0ng-Passw0rd", into: application.secureTextFields["register-password"], of: application)
    }

    /// Return on the password field (`.go`) sends the form and closes the keyboard.
    private func submitForm(_ application: XCUIApplication) {
        application.secureTextFields["register-password"].typeText("\n")
    }

    private func enterCode(_ application: XCUIApplication, _ digits: String) {
        let field = codeField(application)
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(digits)
    }

    private func confirmDeletionAlert(_ application: XCUIApplication) {
        // The first tap may only dismiss the keyboard: retry until the alert shows.
        let alert = application.alerts.firstMatch
        for _ in 0..<4 where !alert.exists {
            let button = application.buttons["delete-confirm"]
            if button.isHittable {
                button.tap()
            } else {
                button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
            _ = alert.waitForExistence(timeout: 3)
        }
        XCTAssertTrue(alert.exists, "Deletion must ask for a final confirmation")
        alert.buttons["Удалить"].tap()
    }

    private func signIn(_ application: XCUIApplication, username: String, password: String) {
        type(username, into: application.textFields["login-username"], of: application)
        type(password, into: application.secureTextFields["login-password"], of: application)
        let submit = application.buttons["login-submit"]
        XCTAssertTrue(submit.isEnabled, "«Войти» must enable once both fields are filled.")
        submit.tap()
    }

    /// Focuses the field and waits for the keyboard before typing.
    private func type(_ text: String, into field: XCUIElement, of application: XCUIApplication) {
        XCTAssertTrue(field.waitForExistence(timeout: 10), "Missing field \(field)")
        for _ in 0..<3 {
            field.tap()
            if application.keyboards.firstMatch.waitForExistence(timeout: 3) {
                break
            }
        }
        XCTAssertTrue(application.keyboards.firstMatch.exists, "The field must receive keyboard focus")
        field.typeText(text)
    }

    /// Swipes the screen up until the element is on screen (at most a few times).
    private func scrollTo(_ element: XCUIElement, in application: XCUIApplication) {
        for _ in 0..<8 where !(element.exists && element.isHittable && element.frame.maxY < application.frame.height - 110) {
            application.swipeUp(velocity: .slow)
        }
    }
}
