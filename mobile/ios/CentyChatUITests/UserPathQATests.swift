import XCTest

/// End-to-end user path from the QA plan (mobile/qa), recorded as one video in CI
/// (artifact `ios-ui-video`): login -> conversations list -> open chat -> send a message ->
/// receive a message (pushed by Bob through the stand's REST API) -> channels ->
/// announcements -> profile -> logout.
///
/// Synchronisation is by `waitForExistence`/predicates only. Coordinates are used solely when
/// XCUI reports an element as not hittable (rows inside SwiftUI lists).
///
/// DEV ONLY: talks to the local dev stand (`CENTYCHAT_DEV_STAND_URL`), never to production.
///
/// Scenario slots for other test files (do not add them here):
///   - registration, delete-account, report/block  -> separate files owned by the UI-parity work
@MainActor
final class UserPathQATests: XCTestCase {
    private let alice = (username: "alice", password: "Alice-Dev-Stand-5271")
    private let bob = (username: "bob", password: "Bob-Dev-Stand-6384")

    private var standURL: String? {
        guard let value = ProcessInfo.processInfo.environment["CENTYCHAT_DEV_STAND_URL"], !value.isEmpty else {
            return nil
        }
        return value
    }

    // MARK: - Scenario

    func testUserPathEndToEnd() throws {
        guard let standURL else {
            throw XCTSkip("The dev stand is not running (CENTYCHAT_DEV_STAND_URL is not set).")
        }
        continueAfterFailure = false
        let stamp = Int(Date().timeIntervalSince1970)
        let outgoing = "QA исходящее \(stamp)"
        let incoming = "QA входящее \(stamp)"

        let app = XCUIApplication()
        app.launchEnvironment["CENTYCHAT_UI_TESTING"] = "1"
        app.launchArguments += ["-reset-secure-state", "-centychat-server-url", standURL, "-centychat-color-scheme", "light"]
        app.launch()

        // 1. Login.
        XCTAssertTrue(app.descendants(matching: .any)["login-screen"].waitForExistence(timeout: 20), "Login must open first.")
        signIn(app, username: alice.username, password: alice.password)
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 40), "Alice must reach the tabs.")

        // 2. Conversations list.
        let dialog = app.staticTexts["Боб Тестов"]
        XCTAssertTrue(dialog.waitForExistence(timeout: 40), "The seeded dialog with Bob must be listed.")

        // 3. Open the chat and see the history.
        let chatBar = app.navigationBars["Боб Тестов"]
        for _ in 0..<3 where !chatBar.exists {
            tap(dialog)
            _ = chatBar.waitForExistence(timeout: 8)
        }
        if !chatBar.exists { print("UI-DUMP list:
" + app.debugDescription) }
        XCTAssertTrue(chatBar.exists, "Tapping the dialog must open the chat.")
        let composer = app.descendants(matching: .any)
            .matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", "Сообщение...", "Сообщение...")).firstMatch
        if !composer.waitForExistence(timeout: 15) { print("UI-DUMP chat:
" + app.debugDescription) }
        XCTAssertTrue(composer.exists, "The message composer must be shown.")
        let seededMessage = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Всё работает")).firstMatch
        if !seededMessage.waitForExistence(timeout: 30) { print("UI-DUMP history:
" + app.debugDescription) }
        XCTAssertTrue(seededMessage.exists, "The seeded history must load in the chat.")

        // 4. Send a message.
        type(outgoing, into: composer, of: app)
        let send = app.buttons["Отправить"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(waitUntil(send, "isEnabled == true"), "Send must enable once text is typed.")
        send.tap()
        XCTAssertTrue(app.staticTexts[outgoing].waitForExistence(timeout: 30), "The sent message must appear in the chat.")

        // 5. Receive a message sent by Bob through the REST API while the chat is open.
        let delivered = StandAPI(baseURL: standURL).sendDirect(from: bob, to: alice.username, text: incoming)
        XCTAssertTrue(delivered, "The stand must accept Bob's message.")
        XCTAssertTrue(app.staticTexts[incoming].waitForExistence(timeout: 30), "The incoming message must arrive live.")

        // Back to the list: the dialog row must now carry the latest text.
        goBack(app)
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Боб Тестов"].waitForExistence(timeout: 10))

        // 6. Channels.
        let channelsSegment = app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Каналы")).firstMatch
        XCTAssertTrue(channelsSegment.waitForExistence(timeout: 10))
        channelsSegment.tap()
        let channel = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "mobile-dev")).firstMatch
        XCTAssertTrue(channel.waitForExistence(timeout: 30), "The seeded channel must be listed.")
        tap(channel)
        XCTAssertTrue(
            app.staticTexts["Добро пожаловать в #mobile-dev."].waitForExistence(timeout: 30),
            "The channel history must load."
        )
        goBack(app)
        let directSegment = app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Личные")).firstMatch
        if directSegment.waitForExistence(timeout: 5) { directSegment.tap() }

        // 7. Announcements.
        let announcementsTab = app.tabBars.buttons["Объявления"]
        XCTAssertTrue(announcementsTab.waitForExistence(timeout: 5))
        announcementsTab.tap()
        let announcement = app.staticTexts["Тестовое оповещение"]
        XCTAssertTrue(announcement.waitForExistence(timeout: 30), "The seeded announcement must be listed.")
        tap(announcement)
        let close = app.buttons["Закрыть"]
        XCTAssertTrue(close.waitForExistence(timeout: 10), "The announcement detail sheet must open.")
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 10))

        // 8. Profile and presence section.
        let profileTab = app.tabBars.buttons["Профиль"]
        XCTAssertTrue(profileTab.waitForExistence(timeout: 5))
        profileTab.tap()
        XCTAssertTrue(app.staticTexts["Алиса Тестова"].waitForExistence(timeout: 20), "The profile must show the signed-in user.")

        // 9. Logout.
        let logout = app.buttons["Выйти из аккаунта"]
        XCTAssertTrue(logout.waitForExistence(timeout: 10))
        tap(logout)
        let confirm = app.alerts.buttons["Выйти"]
        if confirm.waitForExistence(timeout: 3) { confirm.tap() }
        XCTAssertTrue(
            app.descendants(matching: .any)["login-screen"].waitForExistence(timeout: 30),
            "Logout must return to the login screen."
        )
        app.terminate()
    }

    // MARK: - Helpers

    private func signIn(_ app: XCUIApplication, username: String, password: String) {
        let usernameField = app.textFields["login-username"]
        XCTAssertTrue(usernameField.waitForExistence(timeout: 10))
        type(username, into: usernameField, of: app)
        let passwordField = app.secureTextFields["login-password"]
        XCTAssertTrue(passwordField.waitForExistence(timeout: 10))
        type(password, into: passwordField, of: app)
        let submit = app.buttons["login-submit"]
        XCTAssertTrue(waitUntil(submit, "isEnabled == true"), "«Войти» must enable once both fields are filled.")
        submit.tap()
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

    /// Rows and labels inside SwiftUI lists are reported as not hittable (and asking
    /// isHittable itself raises a failure), so they are tapped at the centre of their frame.
    private func tap(_ element: XCUIElement) {
        let frame = element.frame
        XCTAssertFalse(frame.isEmpty, "Cannot tap an element without a frame")
        let window = XCUIApplication().windows.firstMatch
        window.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: frame.midX, dy: frame.midY))
            .tap()
    }

    private func goBack(_ app: XCUIApplication) {
        let back = app.navigationBars.buttons.element(boundBy: 0)
        if back.waitForExistence(timeout: 5) {
            back.tap()
        } else {
            let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.5))
            edge.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
        }
    }

    private func waitUntil(_ element: XCUIElement, _ format: String, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}

/// Minimal REST client for the dev stand: lets a second user ("Bob") write to Alice while the
/// UI is running. Accepts the stand's certificate for localhost only.
private final class StandAPI: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let baseURL: URL

    init(baseURL: String) {
        self.baseURL = URL(string: baseURL)!
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           challenge.protectionSpace.host == "localhost" || challenge.protectionSpace.host == "127.0.0.1",
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    func sendDirect(from sender: (username: String, password: String), to recipient: String, text: String) -> Bool {
        guard
            let senderLogin = post("/api/auth/login", ["username": sender.username, "password": sender.password], token: nil),
            let token = senderLogin["token"] as? String,
            let recipientId = userId(named: recipient, token: token)
        else { return false }
        return post("/api/messages/direct/\(recipientId)", ["text": text], token: token) != nil
    }

    private func userId(named username: String, token: String) -> Int? {
        guard let users = get("/api/users", token: token) as? [[String: Any]] else { return nil }
        return users.first { ($0["username"] as? String) == username }?["id"] as? Int
    }

    private func post(_ path: String, _ body: [String: String], token: String?) -> [String: Any]? {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return send(request) as? [String: Any]
    }

    private func get(_ path: String, token: String) -> Any? {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return send(request)
    }

    private func send(_ request: URLRequest) -> Any? {
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let box = ResultBox()
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { data, response, _ in
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), let data {
                box.value = (try? JSONSerialization.jsonObject(with: data)) ?? [String: Any]()
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 30)
        return box.value
    }

    private final class ResultBox: @unchecked Sendable {
        var value: Any?
    }
}
