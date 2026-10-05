import XCTest

/// «Сотрудники», the person card and the search in «Чаты» against the dev stand:
/// tabs → search → card → «Написать» → back → back, then the «Сотрудники» tab; plus screenshots
/// of the three screens in light, dark and an accessibility text size (published by CI to
/// `ci/ios-screenshots`).
///
/// DEV ONLY: talks to the local dev stand (`CENTYCHAT_DEV_STAND_URL`), never to production.
@MainActor
final class PeopleSearchUITests: XCTestCase {
    private static let accessibilitySize = "UICTContentSizeCategoryAccessibilityXXXL"
    private let alice = (username: "alice", password: "Alice-Dev-Stand-5271")

    private var standURL: String? {
        guard let value = ProcessInfo.processInfo.environment["CENTYCHAT_DEV_STAND_URL"], !value.isEmpty else {
            return nil
        }
        return value
    }

    // MARK: - Path

    func testSearchToCardToChatAndBack() throws {
        guard let standURL else {
            throw XCTSkip("The dev stand is not running (CENTYCHAT_DEV_STAND_URL is not set).")
        }
        continueAfterFailure = false
        let app = launchSignedIn(server: standURL, appearance: .light)

        // Four tabs, «Чаты» first.
        let tabs = app.tabBars.firstMatch
        for title in ["Чаты", "Сотрудники", "Объявления", "Профиль"] {
            XCTAssertTrue(tabs.buttons[title].exists, "The tab bar must offer «\(title)»")
        }

        // Search in «Чаты»: people come from the directory.
        search("Боб", in: app)
        let results = app.descendants(matching: .any)["search-results"]
        XCTAssertTrue(results.waitForExistence(timeout: 20), "The search must show its own results screen")
        let personRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "search-person-")).firstMatch
        XCTAssertTrue(personRow.waitForExistence(timeout: 30), "Bob must be found among the people")
        tapCentre(personRow)

        // The card.
        let card = app.descendants(matching: .any)["person-card"]
        XCTAssertTrue(card.waitForExistence(timeout: 15), "The person card must open")
        XCTAssertTrue(app.staticTexts["Боб Тестов"].waitForExistence(timeout: 10))
        let write = app.buttons["person-write"]
        XCTAssertTrue(write.waitForExistence(timeout: 10))

        // «Написать» pushes the chat onto the same stack.
        tapCentre(write)
        XCTAssertTrue(app.navigationBars["Боб Тестов"].waitForExistence(timeout: 15), "«Написать» must open the dialog")
        XCTAssertEqual(app.tabBars.buttons["Чаты"].isSelected, true, "No tab switch: the chat opens in «Чаты»")

        // Back → card → search results.
        goBack(app)
        XCTAssertTrue(card.waitForExistence(timeout: 10), "Back from the chat returns to the card")
        goBack(app)
        XCTAssertTrue(results.waitForExistence(timeout: 10), "Back from the card returns to the search results")

        // «Сотрудники»: Bob is listed and his card opens from there too.
        openTab("Сотрудники", in: app)
        let list = app.descendants(matching: .any)["people-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 20), "«Сотрудники» must show the directory")
        XCTAssertTrue(
            app.descendants(matching: .any)["people-summary"].waitForExistence(timeout: 10),
            "The summary line must be shown"
        )
        let bobRow = list.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "person-row-")).firstMatch
        XCTAssertTrue(bobRow.waitForExistence(timeout: 30), "The directory must list colleagues")
        tapCentre(bobRow)
        XCTAssertTrue(app.descendants(matching: .any)["person-card"].waitForExistence(timeout: 15))
        goBack(app)
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        app.terminate()
    }

    // MARK: - Screenshots

    func testPeopleScreensForReview() throws {
        guard let standURL else {
            throw XCTSkip("The dev stand is not running (CENTYCHAT_DEV_STAND_URL is not set).")
        }
        continueAfterFailure = false
        defer { XCUIDevice.shared.appearance = .light }
        let variants: [(XCUIDevice.Appearance, String, String?)] = [
            (.light, "light", nil),
            (.dark, "dark", nil),
            (.light, "ax-xxxl", Self.accessibilitySize),
        ]
        for (appearance, suffix, contentSize) in variants {
            let app = launchSignedIn(server: standURL, appearance: appearance, contentSize: contentSize)

            openTab("Сотрудники", in: app)
            let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "person-row-")).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 30), "The directory must load (\(suffix))")
            pause(1)
            capture(app, named: "10-people-\(suffix)")

            tapCentre(row)
            XCTAssertTrue(app.descendants(matching: .any)["person-card"].waitForExistence(timeout: 15))
            pause(1)
            capture(app, named: "11-person-card-\(suffix)")
            goBack(app)

            openTab("Чаты", in: app)
            search("Боб", in: app)
            let person = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "search-person-")).firstMatch
            XCTAssertTrue(person.waitForExistence(timeout: 30), "The search must find Bob (\(suffix))")
            // Message results arrive after the 300 ms pause.
            pause(2)
            capture(app, named: "12-search-\(suffix)")
            app.terminate()
        }
    }

    // MARK: - Helpers

    private func launchSignedIn(server: String, appearance: XCUIDevice.Appearance, contentSize: String? = nil) -> XCUIApplication {
        XCUIDevice.shared.appearance = appearance
        let app = XCUIApplication()
        app.launchEnvironment["CENTYCHAT_UI_TESTING"] = "1"
        app.launchArguments += [
            "-reset-secure-state",
            "-centychat-server-url", server,
            "-centychat-color-scheme", appearance == .dark ? "dark" : "light",
        ]
        if let contentSize {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", contentSize]
        }
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["login-screen"].waitForExistence(timeout: 20), "Login must open first.")
        signIn(app)
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 40), "Alice must reach the tabs.")
        dismissSavePasswordPrompt(app)
        // The inbox has loaded (as in the other signed-in tests) before anything is tapped.
        if !app.staticTexts["Боб Тестов"].waitForExistence(timeout: 30) {
            print("UI-DUMP after sign-in: " + app.debugDescription)
        }
        return app
    }

    /// Tab bar buttons are tapped at their centre: XCUI cannot always scroll them «to visible».
    private func openTab(_ title: String, in app: XCUIApplication) {
        let tab = app.tabBars.firstMatch.buttons[title]
        XCTAssertTrue(tab.waitForExistence(timeout: 10), "The tab «\(title)» must exist")
        tapCentre(tab)
        if !waitUntil(tab, "isSelected == true", timeout: 5) {
            print("UI-DUMP tab \(title): " + app.debugDescription)
            tapCentre(tab)
        }
    }

    private func signIn(_ app: XCUIApplication) {
        let usernameField = app.textFields["login-username"]
        XCTAssertTrue(usernameField.waitForExistence(timeout: 10))
        type(alice.username, into: usernameField, of: app)
        let passwordField = app.secureTextFields["login-password"]
        XCTAssertTrue(passwordField.waitForExistence(timeout: 10))
        type(alice.password, into: passwordField, of: app)
        let submit = app.buttons["login-submit"]
        XCTAssertTrue(waitUntil(submit, "isEnabled == true"), "«Войти» must enable once both fields are filled.")
        submit.tap()
    }

    /// The search field of «Чаты», found by its prompt (other tabs keep theirs in the tree).
    private func search(_ text: String, in app: XCUIApplication) {
        let field = app.searchFields["Люди, каналы, сообщения"]
        XCTAssertTrue(field.waitForExistence(timeout: 15), "The search field must be shown")
        type(text, into: field, of: app, tapAtCentre: true)
    }

    /// Focuses the field and waits for the keyboard before typing.
    private func type(_ text: String, into field: XCUIElement, of app: XCUIApplication, tapAtCentre: Bool = false) {
        for _ in 0..<3 {
            if tapAtCentre {
                tapCentre(field)
            } else {
                field.tap()
            }
            if app.keyboards.firstMatch.waitForExistence(timeout: 3) { break }
        }
        if !app.keyboards.firstMatch.exists { print("UI-DUMP focus: " + app.debugDescription) }
        XCTAssertTrue(app.keyboards.firstMatch.exists, "The field must receive keyboard focus")
        field.typeText(text)
    }

    /// Rows inside SwiftUI lists may be reported as not hittable: tap the centre of the frame.
    private func tapCentre(_ element: XCUIElement) {
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func goBack(_ app: XCUIApplication) {
        let back = app.navigationBars.firstMatch.buttons.element(boundBy: 0)
        if back.waitForExistence(timeout: 5) {
            tapCentre(back)
        } else {
            let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.5))
            edge.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
        }
    }

    /// iOS offers "Save Password?" after a successful login and blocks every tap behind it.
    private func dismissSavePasswordPrompt(_ app: XCUIApplication) {
        let notNow = app.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Не сейчас"])).firstMatch
        if notNow.waitForExistence(timeout: 10) {
            notNow.tap()
            _ = notNow.waitForNonExistence(timeout: 5)
        }
    }

    private func waitUntil(_ element: XCUIElement, _ format: String, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func pause(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    private func capture(_ app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
