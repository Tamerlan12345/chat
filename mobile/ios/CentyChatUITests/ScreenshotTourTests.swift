import XCTest

/// Captures review evidence for every screen reachable without a live server.
/// Screenshots are kept in the xcresult bundle that CI uploads as an artifact.
@MainActor
final class ScreenshotTourTests: XCTestCase {
    private static let checkConnectionTitle = "Проверить подключение"
    private static let invalidURLMessage = "Введите корректный URL (например, https://chat.example.com)"
    private static let connectionFailurePrefix = "Не удалось подключиться"

    func testServerSetupTourInLightAppearance() {
        runServerSetupTour(appearance: .light, suffix: "light")
    }

    func testServerSetupTourInDarkAppearance() {
        runServerSetupTour(appearance: .dark, suffix: "dark")
    }

    private func runServerSetupTour(appearance: XCUIDevice.Appearance, suffix: String) {
        XCUIDevice.shared.appearance = appearance
        defer { XCUIDevice.shared.appearance = .light }

        let application = launchFreshInstall()
        XCTAssertTrue(
            application.otherElements["server-setup"].waitForExistence(timeout: 10),
            "A fresh install must open on server setup."
        )
        capture(application, named: "01-server-setup-\(suffix)")

        let urlField = application.textFields.firstMatch
        XCTAssertTrue(urlField.waitForExistence(timeout: 5))
        type("http://chat.example.com", into: urlField, of: application)
        checkConnectionButton(in: application).tap()
        XCTAssertTrue(
            application.staticTexts[Self.invalidURLMessage].waitForExistence(timeout: 5),
            "Plain HTTP must be rejected before any request is made."
        )
        capture(application, named: "02-server-setup-insecure-url-\(suffix)")

        application.terminate()
        let relaunched = launchFreshInstall()
        let freshURLField = relaunched.textFields.firstMatch
        XCTAssertTrue(freshURLField.waitForExistence(timeout: 10))
        type("https://127.0.0.1:9", into: freshURLField, of: relaunched)
        checkConnectionButton(in: relaunched).tap()
        let failure = relaunched.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", Self.connectionFailurePrefix)
        ).firstMatch
        XCTAssertTrue(
            failure.waitForExistence(timeout: 30),
            "An unreachable server must surface a connection error."
        )
        capture(relaunched, named: "03-server-setup-unreachable-\(suffix)")

        relaunched.terminate()
    }

    private func launchFreshInstall() -> XCUIApplication {
        let application = XCUIApplication()
        application.launchEnvironment["CENTYCHAT_UI_TESTING"] = "1"
        application.launchArguments += ["-reset-secure-state"]
        application.launch()
        return application
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
        XCTAssertTrue(application.keyboards.firstMatch.exists, "The URL field must receive keyboard focus")
        field.typeText(text)
    }

    private func checkConnectionButton(in application: XCUIApplication) -> XCUIElement {
        let button = application.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", Self.checkConnectionTitle)
        ).firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        return button
    }

    private func capture(_ application: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: application.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
