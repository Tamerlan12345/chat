import UIKit
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
        dismissSavePasswordPrompt(app)

        // 2. Conversations list.
        let dialog = app.staticTexts["Боб Тестов"]
        XCTAssertTrue(dialog.waitForExistence(timeout: 40), "The seeded dialog with Bob must be listed.")

        // 3. Open the chat and see the history. Bob writes first, so the newest message is known.
        let latest = "QA последнее \(stamp)"
        XCTAssertTrue(StandAPI(baseURL: standURL).sendDirect(from: bob, to: alice.username, text: latest), "The stand must accept Bob's message.")
        let chatBar = app.navigationBars["Боб Тестов"]
        for _ in 0..<3 where !chatBar.exists {
            tap(dialog)
            _ = chatBar.waitForExistence(timeout: 8)
        }
        if !chatBar.exists { app.dumpForDiagnosis() }
        XCTAssertTrue(chatBar.exists, "Tapping the dialog must open the chat.")
        let composer = app.descendants(matching: .any)
            .matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", "Сообщение...", "Сообщение...")).firstMatch
        if !composer.waitForExistence(timeout: 15) { print("UI-DUMP chat:\n" + app.debugDescription) }
        XCTAssertTrue(composer.exists, "The message composer must be shown.")
        // The chat opens at its newest message: on screen, nothing to jump to.
        // The bubble in the message list, not any other text with the same words.
        let newest = app.scrollViews["chat-messages"].staticTexts[latest]
        XCTAssertTrue(newest.waitForExistence(timeout: 30), "The newest message must be loaded.")
        pause(2)
        XCTAssertTrue(newest.isHittable, "A long chat opens at its newest message, on screen")
        let jumpToLatest = app.buttons["chat-jump-latest"]
        XCTAssertFalse(jumpToLatest.exists, "An opened chat is at its end: no «↓» pill")
        // The seeded history is there above it (scrolled to: the list is lazy).
        let seededMessage = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Всё работает")).firstMatch
        for _ in 0..<15 where !(seededMessage.exists && seededMessage.isHittable) {
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
            from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)))
            _ = seededMessage.waitForExistence(timeout: 1)
        }
        if !seededMessage.exists { print("UI-DUMP history:\n" + app.debugDescription) }
        XCTAssertTrue(seededMessage.exists, "The seeded history must load in the chat.")

        // 4. Send a message.
        type(outgoing, into: composer, of: app)
        let send = app.buttons["Отправить"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(waitUntil(send, "isEnabled == true"), "Send must enable once text is typed.")
        send.tap()
        XCTAssertTrue(app.staticTexts[outgoing].waitForExistence(timeout: 30), "The sent message must appear in the chat.")
        pause(1.5)
        XCTAssertFalse(jumpToLatest.exists, "After sending, the list follows the own message: no «↓» pill")

        // 5. Receive a message sent by Bob through the REST API while the chat is open.
        let delivered = StandAPI(baseURL: standURL).sendDirect(from: bob, to: alice.username, text: incoming)
        XCTAssertTrue(delivered, "The stand must accept Bob's message.")
        XCTAssertTrue(app.staticTexts[incoming].waitForExistence(timeout: 30), "The incoming message must arrive live.")
        pause(1.5)
        XCTAssertFalse(jumpToLatest.exists, "At the end, an incoming message is followed, not counted as «N новых»")

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
        let announcement = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Тестовое оповещение")).firstMatch
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
        // The header is one combined element («Алиса Тестова, Сотрудник»): wait for the profile, then
        // find the name inside any label, not as a separate static text.
        XCTAssertTrue(app.descendants(matching: .any)["profile-list"].waitForExistence(timeout: 20), "The profile must open.")
        let me = app.element(labelContaining: "Алиса Тестова")
        if !me.waitForExistence(timeout: 30) { app.dumpForDiagnosis() }
        XCTAssertTrue(me.exists, "The profile must show the signed-in user.")

        // 9. Logout.
        let logout = app.buttons["profile-sign-out"]
        // The settings form is lazy: scroll until the row is built.
        for _ in 0..<6 where !logout.exists {
            app.swipeUp()
            _ = logout.waitForExistence(timeout: 2)
        }
        XCTAssertTrue(logout.exists, "The profile must offer logout.")
        tap(logout)
        // Sign-out always asks first (final review M3, copy-ru.md §1).
        let question = app.alerts["Выйти из учётной записи?"]
        XCTAssertTrue(question.waitForExistence(timeout: 5), "Sign-out must ask for a confirmation.")
        question.buttons["Выйти"].tap()
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
        // A list row is exposed as one Button whose label merges its texts: tap that button.
        let label = element.label
        if !label.isEmpty {
            let row = XCUIApplication().buttons.matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
            if row.exists {
                XCUIApplication().tapVisiblePart(of: row)
                return
            }
        }
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

    private func pause(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    /// iOS offers "Save Password?" after a successful login and blocks every tap behind it.
    private func dismissSavePasswordPrompt(_ app: XCUIApplication) {
        app.dismissSystemPrompts(timeout: 10)
    }

    private func waitUntil(_ element: XCUIElement, _ format: String, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}

/// Minimal REST client for the dev stand: lets a second user ("Bob") write to Alice while the
/// UI is running, and gives the seeded users photos. Accepts the stand's certificate for localhost only.
final class StandAPI: NSObject, URLSessionDelegate, @unchecked Sendable {
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

    /// The dialog between `user` and `peer` as `user` sees it (`GET /api/messages`, newest 100).
    func directMessages(as user: (username: String, password: String), with peer: String) -> [[String: Any]]? {
        guard
            let login = post("/api/auth/login", ["username": user.username, "password": user.password], token: nil),
            let token = login["token"] as? String,
            let peerId = userId(named: peer, token: token)
        else { return nil }
        var components = URLComponents(url: baseURL.appendingPathComponent("/api/messages"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "conversationType", value: "direct"),
            URLQueryItem(name: "targetId", value: String(peerId)),
            URLQueryItem(name: "limit", value: "100"),
        ]
        guard let url = components?.url else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return send(request) as? [[String: Any]]
    }

    /// `PUT /api/users/avatar` (multipart, field `file`) as `user`: the stand's seed has no photos.
    func uploadAvatar(as user: (username: String, password: String), jpeg: Data) -> Bool {
        guard
            let login = post("/api/auth/login", ["username": user.username, "password": user.password], token: nil),
            let token = login["token"] as? String
        else { return false }
        let boundary = "CentyChatUITest-\(UUID().uuidString)"
        var request = URLRequest(url: baseURL.appendingPathComponent("/api/users/avatar"))
        request.httpMethod = "PUT"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"avatar.jpg\"\r\n".utf8))
        body.append(Data("Content-Type: image/jpeg\r\n\r\n".utf8))
        body.append(jpeg)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        request.httpBody = body
        return send(request) != nil
    }

    /// A photo from `sender` to `recipient` (`POST /api/files/upload`, then an `image` message), so
    /// the chat shows an image attachment the viewer can open.
    func sendPhotoDirect(from sender: (username: String, password: String), to recipient: String) -> Bool {
        guard
            let login = post("/api/auth/login", ["username": sender.username, "password": sender.password], token: nil),
            let token = login["token"] as? String,
            let recipientId = userId(named: recipient, token: token)
        else { return false }
        let jpeg = StandPhotos.landscape()
        let name = "Фото со стенда.jpg"
        let boundary = "CentyChatUITest-\(UUID().uuidString)"
        var request = URLRequest(url: baseURL.appendingPathComponent("/api/files/upload"))
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"stand-photo.jpg\"\r\n".utf8))
        body.append(Data("Content-Type: image/jpeg\r\n\r\n".utf8))
        body.append(jpeg)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        request.httpBody = body
        guard let uploaded = send(request) as? [String: Any], let fileId = uploaded["id"] as? Int else { return false }
        let message: [String: Any] = [
            "text": name,
            "type": "image",
            "metadata": [
                "file_id": fileId,
                "file_name": name,
                "mime_type": "image/jpeg",
                "size": jpeg.count,
                "width": 480,
                "height": 320,
            ],
        ]
        var post = URLRequest(url: baseURL.appendingPathComponent("/api/messages/direct/\(recipientId)"))
        post.httpMethod = "POST"
        post.setValue("application/json", forHTTPHeaderField: "Content-Type")
        post.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        post.httpBody = try? JSONSerialization.data(withJSONObject: message)
        return send(post) != nil
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

/// A landscape picture for an image message (a sunset over hills): clearly a photo in the bubble.
enum StandPhotos {
    static func landscape() -> Data {
        let size = CGSize(width: 480, height: 320)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.jpegData(withCompressionQuality: 0.85) { context in
            let cg = context.cgContext
            let sky = [UIColor(red: 0.98, green: 0.62, blue: 0.42, alpha: 1).cgColor, UIColor(red: 0.42, green: 0.36, blue: 0.78, alpha: 1).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: sky, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size.height), end: .zero, options: [])
            }
            UIColor(red: 1.0, green: 0.86, blue: 0.55, alpha: 1).setFill()
            UIBezierPath(ovalIn: CGRect(x: 300, y: 120, width: 90, height: 90)).fill()
            UIColor(red: 0.20, green: 0.30, blue: 0.36, alpha: 1).setFill()
            UIBezierPath(ovalIn: CGRect(x: -80, y: 210, width: 420, height: 220)).fill()
            UIColor(red: 0.14, green: 0.22, blue: 0.28, alpha: 1).setFill()
            UIBezierPath(ovalIn: CGRect(x: 180, y: 230, width: 400, height: 200)).fill()
        }
    }
}

/// Photos for the stand's seeded colleagues, so the screenshots show photo avatars
/// (`mobile/dev/seed.mjs` creates Alice and Bob without one). Uploaded once per test run.
@MainActor
enum StandAvatars {
    private static var uploaded = false

    static func ensureUploaded(standURL: String) -> Bool {
        if uploaded { return true }
        let api = StandAPI(baseURL: standURL)
        let alice = api.uploadAvatar(
            as: (username: "alice", password: "Alice-Dev-Stand-5271"),
            jpeg: portrait(sky: UIColor(red: 0.42, green: 0.62, blue: 0.95, alpha: 1), shirt: UIColor(red: 0.55, green: 0.20, blue: 0.45, alpha: 1))
        )
        let bob = api.uploadAvatar(
            as: (username: "bob", password: "Bob-Dev-Stand-6384"),
            jpeg: portrait(sky: UIColor(red: 0.98, green: 0.72, blue: 0.38, alpha: 1), shirt: UIColor(red: 0.12, green: 0.42, blue: 0.33, alpha: 1))
        )
        uploaded = alice && bob
        return uploaded
    }

    /// A simple head-and-shoulders picture on a gradient: clearly a photo, not initials.
    private static func portrait(sky: UIColor, shirt: UIColor) -> Data {
        let side: CGFloat = 256
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
        return renderer.jpegData(withCompressionQuality: 0.9) { context in
            let cg = context.cgContext
            let colors = [sky.cgColor, UIColor.white.cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: side), options: [])
            }
            shirt.setFill()
            UIBezierPath(ovalIn: CGRect(x: 38, y: 170, width: 180, height: 150)).fill()
            UIColor(red: 0.95, green: 0.78, blue: 0.66, alpha: 1).setFill()
            UIBezierPath(rect: CGRect(x: 110, y: 140, width: 36, height: 40)).fill()
            UIBezierPath(ovalIn: CGRect(x: 83, y: 60, width: 90, height: 100)).fill()
            UIColor(red: 0.27, green: 0.18, blue: 0.12, alpha: 1).setFill()
            UIBezierPath(ovalIn: CGRect(x: 78, y: 48, width: 100, height: 52)).fill()
        }
    }
}
