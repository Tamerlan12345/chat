import XCTest

/// The never-lose path (`delivery-state.md`): Alice writes to Bob while the message transport is
/// down — the bubble waits as «Ожидает отправки» and the composer clears only because the message is
/// on disk — the app is terminated, relaunched with the transport back, reconnects, and Bob's side
/// has the message exactly once. Screenshots of both states go to `ci/ios-screenshots`.
///
/// The transport is taken down only inside the app (`-centychat-ui-delivery-offline`: the socket
/// points at a closed port, the delivery HTTP requests fail as without a network); sign-in and history
/// still use the stand, which is never changed.
///
/// DEV ONLY: talks to the local dev stand (`CENTYCHAT_DEV_STAND_URL`), never to production.
@MainActor
final class OfflineQueueUITests: XCTestCase {
    private let alice = (username: "alice", password: "Alice-Dev-Stand-5271")
    private let bob = (username: "bob", password: "Bob-Dev-Stand-6384")

    private var standURL: String? {
        guard let value = ProcessInfo.processInfo.environment["CENTYCHAT_DEV_STAND_URL"], !value.isEmpty else {
            return nil
        }
        return value
    }

    func testAMessageWrittenOfflineIsDeliveredOnceAfterARelaunch() throws {
        guard let standURL else {
            throw XCTSkip("The dev stand is not running (CENTYCHAT_DEV_STAND_URL is not set).")
        }
        continueAfterFailure = false
        let text = "Офлайн \(Int(Date().timeIntervalSince1970))"

        // 1. Signed in, the message transport down.
        let offline = launch(server: standURL, extra: ["-reset-secure-state", "-centychat-ui-delivery-offline"])
        XCTAssertTrue(offline.descendants(matching: .any)["login-screen"].waitForExistence(timeout: 20), "Login must open first.")
        signIn(offline)
        XCTAssertTrue(offline.tabBars.firstMatch.waitForExistence(timeout: 40), "Alice must reach the tabs.")
        offline.dismissSystemPrompts(timeout: 10)
        // The inbox while the message transport is down (the connection banner, once it shows).
        _ = offline.staticTexts["Боб Тестов"].waitForExistence(timeout: 40)
        pause(3)
        capture(offline, named: "19-offline-inbox")
        openChatWithBob(offline)

        // 2. Send: the bubble waits in the queue; the composer is empty (the entry is on disk).
        let composer = composerField(offline)
        type(text, into: composer, of: offline)
        let send = offline.buttons["Отправить"]
        XCTAssertTrue(waitUntil(send, "isEnabled == true"), "Send must enable once text is typed.")
        send.tap()
        XCTAssertTrue(offline.staticTexts[text].waitForExistence(timeout: 15), "The queued message must be shown at once.")
        XCTAssertTrue(
            mark(in: offline, labels: ["Ожидает отправки", "Отправляется"]).waitForExistence(timeout: 15),
            "Without a transport the message waits as «Ожидает отправки»."
        )
        XCTAssertFalse(((composer.value as? String) ?? "").contains(text), "The composer clears after the durable enqueue.")
        XCTAssertEqual(countOnBobsSide(text, standURL: standURL), 0, "Nothing reached the server while the transport was down.")
        pause(2)
        capture(offline, named: "20-offline-queued")

        // 3. Terminate; relaunch with the transport back (same install, session kept).
        offline.terminate()
        let online = launch(server: standURL, extra: [])
        XCTAssertTrue(online.tabBars.firstMatch.waitForExistence(timeout: 40), "The stored session must be restored.")
        online.dismissSystemPrompts(timeout: 4)
        openChatWithBob(online)
        XCTAssertTrue(online.staticTexts[text].waitForExistence(timeout: 30), "The queued message survived the relaunch.")

        // 4. Reconnect → sync → send: the bubble is confirmed, Bob has it exactly once.
        let sent = mark(in: online, labels: ["Отправлено", "Доставлено", "Прочитано"])
        XCTAssertTrue(sent.waitForExistence(timeout: 60), "After the reconnect the message must be confirmed.")
        let pending = mark(in: online, labels: ["Ожидает отправки", "Отправляется", "Не отправлено"])
        XCTAssertTrue(pending.waitForNonExistence(timeout: 60), "Nothing may stay in the queue.")
        var delivered = 0
        for _ in 0..<15 {
            delivered = countOnBobsSide(text, standURL: standURL)
            if delivered > 0 { break }
            pause(1)
        }
        XCTAssertEqual(delivered, 1, "Exactly one delivery: the same client_msg_id is never stored twice.")
        pause(1)
        capture(online, named: "21-reconnected-sent")
        online.terminate()
    }

    // MARK: - Helpers

    private func launch(server: String, extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CENTYCHAT_UI_TESTING"] = "1"
        app.launchArguments += extra + ["-centychat-server-url", server, "-centychat-color-scheme", "light"]
        app.launch()
        return app
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

    private func openChatWithBob(_ app: XCUIApplication) {
        let dialog = app.staticTexts["Боб Тестов"]
        XCTAssertTrue(dialog.waitForExistence(timeout: 40), "The seeded dialog with Bob must be listed.")
        let chatBar = app.navigationBars["Боб Тестов"]
        for _ in 0..<3 where !chatBar.exists {
            tapRow(containing: "Боб Тестов", in: app)
            _ = chatBar.waitForExistence(timeout: 8)
        }
        if !chatBar.exists { app.dumpForDiagnosis() }
        XCTAssertTrue(chatBar.exists, "Tapping the dialog must open the chat.")
        XCTAssertTrue(composerField(app).waitForExistence(timeout: 15), "The composer must be shown.")
    }

    private func composerField(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", "Сообщение...", "Сообщение...")).firstMatch
    }

    private func mark(in app: XCUIApplication, labels: [String]) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@ AND label IN %@", "delivery-mark", labels)).firstMatch
    }

    /// Bob's view of the dialog through the stand's REST API: copies of `text`.
    private func countOnBobsSide(_ text: String, standURL: String) -> Int {
        let messages = StandAPI(baseURL: standURL).directMessages(as: bob, with: alice.username) ?? []
        return messages.filter { ($0["text"] as? String) == text }.count
    }

    /// A list row is exposed as one button whose label merges its texts: tap its centre.
    private func tapRow(containing label: String, in app: XCUIApplication) {
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
        let target = row.exists ? row : app.staticTexts[label]
        app.tapVisiblePart(of: target)
    }

    /// Focuses the field and waits for the keyboard before typing.
    private func type(_ text: String, into field: XCUIElement, of app: XCUIApplication) {
        for _ in 0..<3 {
            field.tap()
            if app.keyboards.firstMatch.waitForExistence(timeout: 3) { break }
        }
        XCTAssertTrue(app.keyboards.firstMatch.exists, "The field must receive keyboard focus")
        field.typeText(text)
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
