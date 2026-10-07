import UIKit
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
    private let bob = (username: "bob", password: "Bob-Dev-Stand-6384")

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
        // The inbox shows Bob's photo, not his initials.
        XCTAssertTrue(StandAvatars.ensureUploaded(standURL: standURL), "The stand must accept the colleagues' photos")
        for (appearance, suffix) in [(XCUIDevice.Appearance.light, "light"), (.dark, "dark")] {
            let application = launchFreshInstall(server: standURL, appearance: appearance)
            XCTAssertTrue(loginScreen(of: application).waitForExistence(timeout: 15), "Login must open first.")
            signIn(application, username: "alice", password: "Alice-Dev-Stand-5271")

            guard application.tabBars.firstMatch.waitForExistence(timeout: 30) else {
                capture(application, named: "03-inbox-alice-\(suffix)-not-reached")
                XCTFail("Alice must reach the signed-in tabs.")
                return
            }
            application.dismissSystemPrompts()
            XCTAssertTrue(
                application.staticTexts["Боб Тестов"].waitForExistence(timeout: 30),
                "The seeded dialog with Bob must load from the stand."
            )
            // Bob's photo is fetched after the row appears.
            pause(2)
            capture(application, named: "03-inbox-alice-\(suffix)")
            application.terminate()
        }
    }

    /// Walk-through for the screen recording in CI (artifact `ios-ui-video`): sign in, inbox,
    /// open the dialog with Bob, back, the profile tab. Navigation is best-effort (no hard
    /// waits on optional elements) so the recording never makes the run flaky.
    func testSignedInWalkthroughForVideo() throws {
        guard let standURL else {
            throw XCTSkip("The dev stand is not running (CENTYCHAT_DEV_STAND_URL is not set).")
        }
        continueAfterFailure = false
        let application = launchFreshInstall(server: standURL, appearance: .light)
        XCTAssertTrue(loginScreen(of: application).waitForExistence(timeout: 15), "Login must open first.")
        waitForAnimations()
        signIn(application, username: "alice", password: "Alice-Dev-Stand-5271")
        XCTAssertTrue(application.tabBars.firstMatch.waitForExistence(timeout: 30), "Alice must reach the tabs.")

        let dialog = application.staticTexts["Боб Тестов"]
        if dialog.waitForExistence(timeout: 30) {
            pause(2)
            // The label sits inside a row that XCUI may report as not hittable: tap by coordinate.
            dialog.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            pause(3)
            // Interactive-pop swipe from the left edge: other nav bar buttons are not scrollable for XCUI.
            let edge = application.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.5))
            edge.press(forDuration: 0.1, thenDragTo: application.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
            pause(1)
        }
        let profileTab = application.tabBars.buttons["Профиль"]
        if profileTab.exists {
            profileTab.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            pause(2)
        }
        application.terminate()
    }

    // MARK: - Every screen (design review evidence)

    /// Every signed-in screen in light: inbox, channels, a chat (own and incoming bubbles, a photo),
    /// the image viewer, the message menu, the call, «Сотрудники» (both scopes), a card, the search,
    /// announcements (list and detail), the profile, the password change and the account deletion.
    func testEveryScreenInLightAppearance() throws {
        try runScreenTour(appearance: .light, suffix: "light")
    }

    func testEveryScreenInDarkAppearance() throws {
        try runScreenTour(appearance: .dark, suffix: "dark")
    }

    func testEveryScreenWithAccessibilityTextSize() throws {
        try runScreenTour(appearance: .light, suffix: "ax-xxxl", contentSize: Self.accessibilitySize)
    }

    /// Registration: the form, the code step and «waiting for the administrator», in light, dark
    /// and an accessibility text size. Answered by the UI-test account stub, no stand needed.
    func testRegistrationScreens() {
        continueAfterFailure = true
        defer { XCUIDevice.shared.appearance = .light }
        let variants: [(XCUIDevice.Appearance, String, String?)] = [
            (.light, "light", nil),
            (.dark, "dark", nil),
            (.light, "ax-xxxl", Self.accessibilitySize),
        ]
        for (appearance, suffix, contentSize) in variants {
            let application = launchFreshInstall(
                server: Self.unreachableServer,
                appearance: appearance,
                contentSize: contentSize,
                extra: ["-centychat-stub-account"]
            )
            XCTAssertTrue(loginScreen(of: application).waitForExistence(timeout: 15))
            let entry = application.buttons["login-register"]
            for _ in 0..<6 where !(entry.exists && entry.isHittable) {
                application.swipeUp(velocity: .slow)
            }
            guard entry.exists else {
                capture(application, named: "30-register-not-reached-\(suffix)")
                application.terminate()
                continue
            }
            entry.tap()
            guard application.descendants(matching: .any)["register-form"].waitForExistence(timeout: 10) else {
                application.terminate()
                continue
            }
            waitForAnimations()
            capture(application, named: "30-register-form-\(suffix)")

            type("petr@pending.test", into: application.textFields["register-email"], of: application)
            type("Пётр Петров", into: application.textFields["register-name"], of: application)
            type("petr.\(suffix)", into: application.textFields["register-username"], of: application)
            type("Str0ng-Passw0rd", into: application.secureTextFields["register-password"], of: application)
            application.secureTextFields["register-password"].typeText("\n")
            let code = application.textFields["register-code"]
            if code.waitForExistence(timeout: 10) {
                waitForAnimations()
                capture(application, named: "31-register-code-\(suffix)")
                code.tap()
                code.typeText("123456")
                let verify = application.buttons["register-verify"]
                if verify.waitForExistence(timeout: 5) { verify.tap() }
                if application.descendants(matching: .any)["register-pending"].waitForExistence(timeout: 10) {
                    waitForAnimations()
                    capture(application, named: "32-register-pending-\(suffix)")
                }
            }
            application.terminate()
        }
    }

    /// The component gallery (`-centychat-ui-gallery`, canned data): every bubble state including a
    /// failed message, banners, empty states, skeletons, buttons and the call stage parts.
    func testComponentGallery() {
        continueAfterFailure = true
        defer { XCUIDevice.shared.appearance = .light }
        let variants: [(XCUIDevice.Appearance, String, String?)] = [
            (.light, "light", nil),
            (.dark, "dark", nil),
            (.light, "ax-xxxl", Self.accessibilitySize),
        ]
        for (appearance, suffix, contentSize) in variants {
            let application = launchFreshInstall(
                server: Self.unreachableServer,
                appearance: appearance,
                contentSize: contentSize,
                extra: ["-centychat-ui-gallery"]
            )
            let gallery = application.scrollViews["design-gallery"]
            XCTAssertTrue(gallery.waitForExistence(timeout: 15), "The gallery must open (\(suffix))")
            for (index, page) in ["Сообщения", "Состояния", "Кнопки", "Звонок"].enumerated() {
                let segment = application.segmentedControls.buttons[page]
                if segment.waitForExistence(timeout: 5) {
                    segment.tap()
                }
                pause(1.2)
                capture(application, named: "40-gallery-\(index + 1)-\(suffix)")
                if index == 0 {
                    // The rest of the bubbles (the failed one and the glyph row) below the fold.
                    gallery.swipeUp(velocity: .slow)
                    pause(1)
                    capture(application, named: "40-gallery-1b-\(suffix)")
                }
            }
            application.terminate()
        }
    }

    /// iPad (regular width): the inbox and the chat side by side, and the tab bar stays while a chat
    /// is selected (a chat hides it only when pushed full screen on iPhone). Runs on the iPad
    /// simulator only (its own CI step); skipped on iPhone.
    func testIPadSplitViewKeepsTheTabBar() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else {
            throw XCTSkip("iPad only.")
        }
        guard let standURL else {
            throw XCTSkip("The dev stand is not running (CENTYCHAT_DEV_STAND_URL is not set).")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        defer {
            XCUIDevice.shared.orientation = .portrait
            XCUIDevice.shared.appearance = .light
        }
        for (appearance, suffix) in [(XCUIDevice.Appearance.light, "light"), (.dark, "dark")] {
            let app = launchFreshInstall(server: standURL, appearance: appearance)
            XCTAssertTrue(loginScreen(of: app).waitForExistence(timeout: 20), "Login must open first.")
            // The iPad simulator may use a hardware keyboard: type without waiting for the on-screen one.
            for (identifier, text, secure) in [("login-username", "alice", false), ("login-password", "Alice-Dev-Stand-5271", true)] {
                let field = secure ? app.secureTextFields[identifier] : app.textFields[identifier]
                XCTAssertTrue(field.waitForExistence(timeout: 10))
                field.tap()
                pause(0.5)
                field.typeText(text)
            }
            let submit = app.buttons["login-submit"]
            XCTAssertTrue(waitUntil(submit, "isEnabled == true"), "«Войти» must enable once both fields are filled.")
            submit.tap()
            let bob = app.staticTexts["Боб Тестов"]
            XCTAssertTrue(bob.waitForExistence(timeout: 40), "The inbox must list Bob in the sidebar.")
            app.dismissSystemPrompts()
            let peopleTab = app.buttons.matching(NSPredicate(format: "label == %@", "Сотрудники")).firstMatch
            XCTAssertTrue(peopleTab.waitForExistence(timeout: 10), "The tab bar must be shown on iPad")
            pause(1)
            capture(app, named: "50-ipad-split-\(suffix)")

            // Bob writes first, so the newest message is known.
            let latest = "iPad последнее \(suffix) \(Int(Date().timeIntervalSince1970) % 100_000)"
            XCTAssertTrue(StandAPI(baseURL: standURL).sendDirect(from: self.bob, to: "alice", text: latest), "The stand must accept Bob's message")
            let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Боб Тестов")).firstMatch
            _ = row.waitForExistence(timeout: 5)
            tapCentre(row.exists ? row : bob)
            XCTAssertTrue(composerField(app).waitForExistence(timeout: 15), "The chat must open in the detail column")
            let newest = app.staticTexts[latest]
            XCTAssertTrue(newest.waitForExistence(timeout: 20), "The newest message must be loaded")
            pause(2)
            // Evidence first, so a failure still shows the screen and the geometry.
            capture(app, named: "51-ipad-split-chat-\(suffix)")
            logChatGeometry(app, newest: newest, moment: "iPad \(suffix)")
            XCTAssertTrue(newest.isHittable, "A long chat opens at its newest message, on screen")
            XCTAssertTrue(peopleTab.exists && peopleTab.isHittable, "With a chat selected, the tab bar stays on iPad")
            app.terminate()
        }
    }

    /// The motion walkthrough for the brief's screen recordings (CI records it on its own:
    /// `CENTYCHAT_MOTION_VIDEO=light|dark`): inbox → chat, the keyboard and its interactive dismiss,
    /// a message landing, swipe-to-reply, the context menu, an empty search, the people flow.
    func testMotionWalkthrough() throws {
        guard let standURL else {
            throw XCTSkip("The dev stand is not running (CENTYCHAT_DEV_STAND_URL is not set).")
        }
        guard let mode = ProcessInfo.processInfo.environment["CENTYCHAT_MOTION_VIDEO"], !mode.isEmpty else {
            throw XCTSkip("Recorded on its own by CI (CENTYCHAT_MOTION_VIDEO).")
        }
        continueAfterFailure = true
        defer { XCUIDevice.shared.appearance = .light }
        let appearance: XCUIDevice.Appearance = mode == "dark" ? .dark : .light
        // Unique per recording: the Reduce Motion pass runs in light after the light pass.
        let motionText = "Движение \(mode) \(Int(Date().timeIntervalSince1970) % 100_000)"
        let app = launchFreshInstall(server: standURL, appearance: appearance)
        XCTAssertTrue(loginScreen(of: app).waitForExistence(timeout: 15))
        signIn(app, username: "alice", password: "Alice-Dev-Stand-5271")
        guard app.tabBars.firstMatch.waitForExistence(timeout: 30) else { return }
        app.dismissSystemPrompts()
        pause(2)

        // Inbox → chat (zoom from the row on iOS 18).
        if openChat(titled: "Боб Тестов", in: app) {
            pause(2)
            // The keyboard: open, type, send (the message lands), interactive dismiss.
            let composer = composerField(app)
            if composer.waitForExistence(timeout: 10) {
                type(motionText, into: composer, of: app)
                pause(0.6)
                let send = app.buttons["Отправить"]
                if waitUntil(send, "isEnabled == true", timeout: 5) { send.tap() }
                pause(2)
                closeKeyboardByDraggingTheList(app)
                pause(1)
            }
            // Swipe-to-reply on the own message, then cancel the reply.
            let own = app.staticTexts[motionText]
            if own.waitForExistence(timeout: 5) {
                let start = own.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
                start.press(forDuration: 0.05, thenDragTo: own.coordinate(withNormalizedOffset: CGVector(dx: -0.6, dy: 0.5)))
                pause(1.5)
                let cancelReply = app.buttons["Отменить ответ"]
                if cancelReply.exists { cancelReply.tap() }
                pause(1)
                // The context menu.
                own.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.2)
                pause(1.5)
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.12)).tap()
                pause(1)
            }
            // The card from the header and back.
            let header = app.buttons["chat-header-avatar"]
            if header.exists {
                tapCentre(header)
                pause(2)
                goBack(app)
            }
            goBack(app)
            pause(1)
        }

        // An empty search state, then the people flow.
        let field = app.searchFields["Люди, каналы, сообщения"]
        if field.waitForExistence(timeout: 10) {
            type("щщщщ", into: field, of: app, tapAtCentre: true)
            pause(2.5)
            for label in ["Отменить", "Cancel"] where app.buttons[label].exists {
                app.buttons[label].tap()
                break
            }
            pause(1)
        }
        if openTab("Сотрудники", in: app) {
            pause(1.5)
            let departments = app.segmentedControls.buttons["Отделы"]
            if departments.exists {
                departments.tap()
                pause(1)
                let department = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "department-")).element(boundBy: 1)
                if department.exists {
                    tapCentre(department)
                    pause(1.5)
                    tapCentre(department)
                    pause(1)
                }
            }
        }
        if openTab("Объявления", in: app) {
            pause(2)
        }
        app.terminate()
    }

    private func runScreenTour(appearance: XCUIDevice.Appearance, suffix: String, contentSize: String? = nil) throws {
        guard let standURL else {
            throw XCTSkip("The dev stand is not running (CENTYCHAT_DEV_STAND_URL is not set).")
        }
        // Evidence, not a gate: one screen that cannot be reached must not hide the others.
        continueAfterFailure = true
        defer { XCUIDevice.shared.appearance = .light }
        XCTAssertTrue(StandAvatars.ensureUploaded(standURL: standURL), "The stand must accept the colleagues' photos")
        // A photo from Bob, so the chat shows an image attachment and the viewer can open.
        XCTAssertTrue(StandAPI(baseURL: standURL).sendPhotoDirect(from: bob, to: "alice"), "Bob's photo must reach Alice")

        var app = launchFreshInstall(server: standURL, appearance: appearance, contentSize: contentSize)
        XCTAssertTrue(loginScreen(of: app).waitForExistence(timeout: 15), "Login must open first.")
        signIn(app, username: "alice", password: "Alice-Dev-Stand-5271")
        guard app.tabBars.firstMatch.waitForExistence(timeout: 30) else {
            capture(app, named: "03-inbox-not-reached-\(suffix)")
            XCTFail("Alice must reach the signed-in tabs.")
            return
        }
        app.dismissSystemPrompts()
        _ = app.staticTexts["Боб Тестов"].waitForExistence(timeout: 30)
        pause(2)
        capture(app, named: "03-inbox-\(suffix)")

        // «Каналы».
        let channels = app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Каналы")).firstMatch
        if channels.waitForExistence(timeout: 5) {
            channels.tap()
            _ = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "mobile-dev")).firstMatch.waitForExistence(timeout: 15)
            pause(1)
            capture(app, named: "04-channels-\(suffix)")
            let direct = app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Личные")).firstMatch
            if direct.exists { direct.tap() }
        }

        // The dialog with Bob: history, a photo, an own message just sent.
        if openChat(titled: "Боб Тестов", in: app) {
            _ = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS %@", "Всё работает")).firstMatch
                .waitForExistence(timeout: 20)
            let own = "Снимок экрана \(suffix)"
            let composer = composerField(app)
            if composer.waitForExistence(timeout: 10) {
                type(own, into: composer, of: app)
                let send = app.buttons["Отправить"]
                if waitUntil(send, "isEnabled == true", timeout: 5) { send.tap() }
                _ = app.staticTexts[own].waitForExistence(timeout: 15)
                closeKeyboardByDraggingTheList(app)
            }
            pause(2)
            capture(app, named: "05-chat-\(suffix)")

            // The photo opens full screen.
            let photo = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label BEGINSWITH %@", "Фото ")).firstMatch
            if photo.waitForExistence(timeout: 10) {
                tapCentre(photo)
                let viewer = app.descendants(matching: .any)["image-viewer"]
                if viewer.waitForExistence(timeout: 10) {
                    pause(2)
                    capture(app, named: "06-image-viewer-\(suffix)")
                    let close = app.buttons["image-viewer-close"]
                    // The cover may still be settling: wait for the button, retry once.
                    for _ in 0..<2 where viewer.exists {
                        if close.waitForExistence(timeout: 5) { tapCentre(close) }
                        _ = viewer.waitForNonExistence(timeout: 5)
                    }
                }
            }

            // The long-press menu of the own message.
            let bubble = app.staticTexts[own]
            if bubble.waitForExistence(timeout: 5) {
                // A bubble inside the list may be reported as not hittable: press at its centre.
                bubble.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.2)
                pause(1)
                capture(app, named: "07-message-menu-\(suffix)")
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.12)).tap()
                pause(1)
            }

            // The call stage (Bob has no socket: the call shows its calling state, then ends).
            let call = app.navigationBars.buttons["Позвонить"]
            if call.exists {
                tapCentre(call)
                pause(1.5)
                dismissMicrophonePrompt()
                // Only a real call stage is evidence: the stand's Bob has no socket, so the call
                // usually ends before it shows (the stage is in the component gallery instead).
                if app.descendants(matching: .any)["call-stage"].waitForExistence(timeout: 2) {
                    capture(app, named: "08-call-\(suffix)")
                }
                endCallIfShown(app)
                if !app.navigationBars["Боб Тестов"].waitForExistence(timeout: 10) {
                    // The call stage would not close: start over with the stored session.
                    app.terminate()
                    app = relaunch(server: standURL, appearance: appearance, contentSize: contentSize)
                }
            }
            if app.navigationBars["Боб Тестов"].exists { goBack(app) }
        }

        // «Сотрудники»: «Все», «Отделы», a card.
        if openTab("Сотрудники", in: app) {
            let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "person-row-")).firstMatch
            _ = row.waitForExistence(timeout: 30)
            pause(1)
            capture(app, named: "10-people-\(suffix)")
            let departments = app.segmentedControls.buttons["Отделы"]
            if departments.waitForExistence(timeout: 5) {
                departments.tap()
                pause(1.5)
                capture(app, named: "10b-departments-\(suffix)")
                let all = app.segmentedControls.buttons["Все"]
                if all.exists { all.tap() }
                pause(1)
            }
            if row.waitForExistence(timeout: 5) {
                tapCentre(row)
                if app.descendants(matching: .any)["person-card"].waitForExistence(timeout: 15) {
                    pause(1.5)
                    capture(app, named: "11-person-card-\(suffix)")
                    goBack(app)
                }
            }
        }

        // The search in «Чаты».
        if openTab("Чаты", in: app) {
            let field = app.searchFields["Люди, каналы, сообщения"]
            if field.waitForExistence(timeout: 10) {
                type("Боб", into: field, of: app, tapAtCentre: true)
                _ = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "search-person-")).firstMatch
                    .waitForExistence(timeout: 20)
                pause(2)
                capture(app, named: "12-search-\(suffix)")
                for label in ["Отменить", "Cancel", "Отмена"] where app.buttons[label].exists {
                    app.buttons[label].tap()
                    break
                }
            }
        }

        // «Объявления»: the list and the detail.
        if openTab("Объявления", in: app) {
            let announcement = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Тестовое оповещение")).firstMatch
            _ = announcement.waitForExistence(timeout: 20)
            pause(1)
            capture(app, named: "13-announcements-\(suffix)")
            if announcement.exists {
                tapCentre(announcement)
                let close = app.buttons["Закрыть"]
                if close.waitForExistence(timeout: 10) {
                    pause(1)
                    capture(app, named: "14-announcement-detail-\(suffix)")
                    close.tap()
                    _ = close.waitForNonExistence(timeout: 10)
                }
            }
        }

        // «Профиль»: top, bottom, the password change and the account deletion.
        if openTab("Профиль", in: app) {
            pause(1.5)
            capture(app, named: "15-profile-\(suffix)")
            let changePassword = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Сменить пароль")).firstMatch
            let list = app.collectionViews["profile-list"]
            for _ in 0..<6 where !(changePassword.exists && changePassword.isHittable) {
                if list.exists { list.swipeUp(velocity: .slow) } else { app.swipeUp(velocity: .slow) }
            }
            if changePassword.exists {
                tapCentre(changePassword)
                pause(1.5)
                capture(app, named: "16-change-password-\(suffix)")
                for label in ["Отмена", "Закрыть"] where app.navigationBars.buttons[label].exists {
                    app.navigationBars.buttons[label].tap()
                    break
                }
                pause(1)
            }
            let deleteEntry = app.buttons["profile-delete-account"]
            for _ in 0..<8 where !(deleteEntry.exists && deleteEntry.frame.maxY < app.frame.height - 110) {
                if list.exists { list.swipeUp(velocity: .slow) } else { app.swipeUp(velocity: .slow) }
            }
            pause(1)
            capture(app, named: "17-profile-bottom-\(suffix)")
            if deleteEntry.exists {
                tapCentre(deleteEntry)
                if app.buttons["delete-confirm"].waitForExistence(timeout: 10) {
                    pause(1)
                    capture(app, named: "18-delete-account-\(suffix)")
                    let cancel = app.buttons["delete-cancel"]
                    if cancel.exists { cancel.tap() }
                }
            }
        }
        app.terminate()
    }

    private func pause(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    // MARK: - Tour

    private func runLoginTour(appearance: XCUIDevice.Appearance, suffix: String, contentSize: String? = nil) {
        continueAfterFailure = false
        defer { XCUIDevice.shared.appearance = .light }
        let server = standURL ?? Self.unreachableServer
        let application = launchFreshInstall(server: server, appearance: appearance, contentSize: contentSize)

        XCTAssertTrue(loginScreen(of: application).waitForExistence(timeout: 15), "A fresh install must open on login.")
        // Only the CentyChat lockup: no company caption (owner, 2026-10-06).
        XCTAssertFalse(application.descendants(matching: .any)["login-company"].exists)
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
        contentSize: String? = nil,
        extra: [String] = [],
        resetSecureState: Bool = true
    ) -> XCUIApplication {
        XCUIDevice.shared.appearance = appearance
        let application = XCUIApplication()
        application.launchEnvironment["CENTYCHAT_UI_TESTING"] = "1"
        if resetSecureState {
            application.launchArguments.append("-reset-secure-state")
        }
        application.launchArguments += extra + [
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
    private func type(_ text: String, into field: XCUIElement, of application: XCUIApplication, tapAtCentre: Bool = false) {
        _ = field.waitForExistence(timeout: 10)
        for _ in 0..<3 {
            if tapAtCentre {
                tapCentre(field)
            } else {
                field.tap()
            }
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

    /// Prints where the newest bubble, the composer and the window are, and the chat's scroll
    /// geometry (`chat-scroll-probe`, UI tests only), so a failed «opens at the newest message» says why.
    private func logChatGeometry(_ application: XCUIApplication, newest: XCUIElement, moment: String) {
        let probe = application.descendants(matching: .any)["chat-scroll-probe"]
        let composer = composerField(application)
        print("CHAT-GEOMETRY \(moment): newest=\(newest.exists ? "\(newest.frame)" : "absent") hittable=\(newest.exists && newest.isHittable) composer=\(composer.exists ? "\(composer.frame)" : "absent") window=\(application.windows.firstMatch.frame) probe=\(probe.exists ? probe.label : "absent")")
    }

    /// The session survives a relaunch without `-reset-secure-state`: back on the tabs.
    private func relaunch(server: String, appearance: XCUIDevice.Appearance, contentSize: String?) -> XCUIApplication {
        let application = launchFreshInstall(server: server, appearance: appearance, contentSize: contentSize, resetSecureState: false)
        _ = application.tabBars.firstMatch.waitForExistence(timeout: 30)
        application.dismissSystemPrompts(timeout: 2)
        return application
    }

    /// Tab bar buttons are tapped at their centre: XCUI cannot always scroll them «to visible».
    @discardableResult
    private func openTab(_ title: String, in application: XCUIApplication) -> Bool {
        let tab = application.tabBars.firstMatch.buttons[title]
        guard tab.waitForExistence(timeout: 10) else { return false }
        for _ in 0..<3 where !tab.isSelected {
            tapCentre(tab)
            _ = waitUntil(tab, "isSelected == true", timeout: 4)
        }
        return tab.isSelected
    }

    /// A list row is one button whose label merges its texts: tap its centre until the chat opens.
    private func openChat(titled title: String, in application: XCUIApplication) -> Bool {
        let chatBar = application.navigationBars[title]
        guard application.staticTexts[title].waitForExistence(timeout: 30) else { return false }
        for _ in 0..<3 where !chatBar.exists {
            let row = application.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
            tapCentre(row.exists ? row : application.staticTexts[title])
            _ = chatBar.waitForExistence(timeout: 8)
        }
        return chatBar.exists
    }

    private func composerField(_ application: XCUIApplication) -> XCUIElement {
        application.descendants(matching: .any)
            .matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", "Сообщение...", "Сообщение...")).firstMatch
    }

    /// The list dismisses the keyboard interactively: drag the messages down.
    private func closeKeyboardByDraggingTheList(_ application: XCUIApplication) {
        guard application.keyboards.firstMatch.exists else { return }
        let start = application.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        start.press(forDuration: 0.05, thenDragTo: application.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        _ = application.keyboards.firstMatch.waitForNonExistence(timeout: 3)
        // The drag also scrolled the history up: «↓» brings the newest message back.
        let jump = application.buttons["chat-jump-latest"]
        if jump.waitForExistence(timeout: 2) {
            jump.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            pause(1.5)
        }
    }

    /// The first call asks for the microphone (SpringBoard alert): declined, the stage explains it.
    private func dismissMicrophonePrompt() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let labels = ["Don’t Allow", "Don't Allow", "Не разрешать", "Запретить"]
        let button = springboard.buttons.matching(NSPredicate(format: "label IN %@", labels)).firstMatch
        if button.waitForExistence(timeout: 2) {
            button.tap()
            pause(1)
        }
    }

    private func endCallIfShown(_ application: XCUIApplication) {
        let end = application.buttons.matching(NSPredicate(
            format: "identifier == %@ OR label IN %@",
            "call-end",
            ["Завершить", "Завершить звонок", "Отменить звонок", "End Call"]
        )).firstMatch
        if end.waitForExistence(timeout: 3) {
            tapCentre(end)
        } else if !application.navigationBars["Боб Тестов"].exists {
            // The round red button at the bottom centre of the call stage.
            application.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.86)).tap()
        }
    }

    private func goBack(_ application: XCUIApplication) {
        let back = application.navigationBars.firstMatch.buttons.element(boundBy: 0)
        if back.waitForExistence(timeout: 5) {
            tapCentre(back)
        } else {
            let edge = application.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.5))
            edge.press(forDuration: 0.1, thenDragTo: application.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
        }
        pause(1)
    }

    /// Rows inside SwiftUI lists may be reported as not hittable: tap the centre of the frame.
    private func tapCentre(_ element: XCUIElement) {
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func waitUntil(_ element: XCUIElement, _ format: String, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func capture(_ application: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: application.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
