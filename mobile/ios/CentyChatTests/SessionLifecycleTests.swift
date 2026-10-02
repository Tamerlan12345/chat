import Foundation
import XCTest
@testable import CentyChat

/// The realtime connection follows the session: it listens whenever the session is
/// authenticated and stops on logout.
@MainActor
final class SessionLifecycleTests: XCTestCase {
    private let wakeRing = TestModels.event(#"{"type":"wake_ring","fromUserId":12,"fromName":"Данияр","at":1759230000000}"#)

    private func assertRealtimeDelivers(_ app: TestApp, file: StaticString = #filePath, line: UInt = #line) async {
        app.container.profile.incomingWakeAlert = nil
        let delivered = await app.realtime.emit(wakeRing)
        XCTAssertTrue(delivered, "Nobody is listening to realtime events", file: file, line: line)
        let alerted = await eventually { app.container.profile.incomingWakeAlert != nil }
        XCTAssertTrue(alerted, "The realtime event did not reach the stores", file: file, line: line)
    }

    func testFirstRunServerSetupThenLoginListensToRealtime() async throws {
        let app = TestApp(serverURL: "")
        await app.session.bootstrap()
        XCTAssertEqual(app.session.phase, .serverSetup)

        try app.session.configureServer(address: "https://chat.example.com", info: ServerInfo())
        let outcome = try await app.session.login(username: "qa", password: "password")

        XCTAssertEqual(outcome, .authenticated)
        XCTAssertEqual(app.session.phase, .authenticated)
        await assertRealtimeDelivers(app)
    }

    func testLoginAfterUnhealthyLaunchListensToRealtime() async throws {
        let app = TestApp()
        app.server.setHealthy(false)
        await app.session.bootstrap()

        _ = try await app.session.login(username: "qa", password: "password")

        XCTAssertEqual(app.session.phase, .authenticated)
        await assertRealtimeDelivers(app)
    }

    func testLogoutStopsRealtimeAndReloginRearmsEventsAndCallAudio() async throws {
        let app = TestApp()
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")
        await assertRealtimeDelivers(app)
        let audioArmedAfterLogin = await app.realtime.hasLiveAudioSubscriber
        XCTAssertTrue(audioArmedAfterLogin, "Call audio must be received after login")

        await app.session.logout()

        XCTAssertEqual(app.session.phase, .signedOut)
        let afterLogout = await (app.realtime.isConnected, app.realtime.hasLiveAudioSubscriber)
        XCTAssertFalse(afterLogout.0, "Logout must close the socket")
        XCTAssertFalse(afterLogout.1)
        XCTAssertEqual(app.container.realtime.connectionState, .disconnected)

        _ = try await app.session.login(username: "qa", password: "password")

        let audioArmedAfterRelogin = await app.realtime.hasLiveAudioSubscriber
        XCTAssertTrue(audioArmedAfterRelogin, "Call audio must be re-armed after logging in again")
        await assertRealtimeDelivers(app)
    }

    func testRestoredSessionListensToRealtime() async {
        let app = TestApp()
        app.auth.state.withValue { $0.hasToken = true }

        await app.session.bootstrap()

        XCTAssertEqual(app.session.phase, .authenticated)
        await assertRealtimeDelivers(app)
    }

    func testServerDisconnectWithAValidTokenKeepsTheSessionAndReconnects() async throws {
        let app = TestApp()
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")
        let connectsBefore = await app.realtime.connectCount

        app.container.realtime.dispatch(TestModels.event(#"{"type":"server_disconnect","reason":"Пароль изменён — переподключение"}"#))

        let reconnected = await eventually { await app.realtime.connectCount > connectsBefore }
        XCTAssertTrue(reconnected, "The socket must reconnect with the current token")
        XCTAssertEqual(app.session.phase, .authenticated)
        let logoutCount = app.auth.state.value.logoutCount
        XCTAssertEqual(logoutCount, 0, "A still-valid session must not be logged out")
    }

    func testServerDisconnectWithARevokedTokenSignsOut() async throws {
        let app = TestApp()
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")
        app.auth.state.withValue { $0.currentUserResult = .failure(APIError.unauthorized) }

        app.container.realtime.dispatch(TestModels.event(#"{"type":"server_disconnect","reason":"Сессия недействительна — войдите заново"}"#))

        let signedOut = await eventually { app.session.phase == .signedOut }
        XCTAssertTrue(signedOut)
        let isConnected = await app.realtime.isConnected
        XCTAssertFalse(isConnected)
    }
}

/// Mandatory password change: one presentation, and the session becomes authenticated afterwards.
@MainActor
final class PasswordChangeFlowTests: XCTestCase {
    func testMandatoryChangeAfterLoginThenAuthenticates() async throws {
        let app = TestApp()
        app.auth.state.withValue {
            $0.loginUser = TestModels.user(id: 1, name: "Тест Тестов", mustChangePassword: true)
            $0.changedPasswordUser = TestModels.user(id: 1, name: "Тест Тестов", mustChangePassword: false)
        }
        await app.session.bootstrap()

        let outcome = try await app.session.login(username: "qa", password: "temporary")

        XCTAssertEqual(outcome, .passwordChangeRequired)
        XCTAssertEqual(app.session.phase, .passwordChangeRequired)

        try await app.session.changePassword(oldPassword: "temporary", newPassword: "new-password-1")

        XCTAssertEqual(app.session.phase, .authenticated)
        XCTAssertEqual(app.session.currentUser?.mustChangePassword, false)
        let delivered = await app.realtime.emit(TestModels.event(#"{"type":"wake_state","retryAt":0}"#))
        XCTAssertTrue(delivered, "Realtime must be listening once the password is changed")
        let loaded = await eventually { app.chat.state.value.directLoadCount > 0 }
        XCTAssertTrue(loaded, "Data must load once the password is changed")
    }

    func testRestoredSessionThatMustChangePasswordWaitsForTheChange() async {
        let app = TestApp()
        app.auth.state.withValue {
            $0.hasToken = true
            $0.currentUserResult = .success(TestModels.user(id: 1, name: "Тест Тестов", mustChangePassword: true))
        }

        await app.session.bootstrap()

        XCTAssertEqual(app.session.phase, .passwordChangeRequired)
        let connects = await app.realtime.connectCount
        XCTAssertEqual(connects, 0, "The server refuses realtime until the password is changed")
    }

    func testVoluntaryChangeReconnectsRealtimeWithTheNewToken() async throws {
        let app = TestApp()
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")
        let before = await (app.realtime.connectCount, app.realtime.disconnectCount)

        try await app.session.changePassword(oldPassword: "password", newPassword: "new-password-1")

        let after = await (app.realtime.connectCount, app.realtime.disconnectCount)
        XCTAssertEqual(after.1, before.1 + 1, "The socket authenticated with the old token must be closed")
        XCTAssertEqual(after.0, before.0 + 1, "A new socket must authenticate with the new token")
        XCTAssertEqual(app.session.phase, .authenticated)
    }
}

/// Every list loads on its own: one failing request does not empty the others.
@MainActor
final class PartialLoadTests: XCTestCase {
    func testFailedChannelsRequestKeepsConversationsUsersAndAnnouncements() async {
        let app = TestApp()
        app.chat.state.withValue {
            $0.directs = .success([TestModels.direct(with: 12)])
            $0.channels = .failure(TestError(message: "Каналы недоступны"))
            $0.users = .success([PublicUser(id: 12, username: "d.n", fullName: "Данияр Нурпеисов")])
        }
        app.announcements.items.withValue { $0 = .success([TestModels.announcement(id: 4)]) }

        await app.container.loadAllData()

        XCTAssertEqual(app.container.conversations.directConversations.map(\.userId), [12])
        XCTAssertEqual(app.container.conversations.users.map(\.id), [12])
        XCTAssertEqual(app.container.announcements.announcements.map(\.id), [4])
    }
}
