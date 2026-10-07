import Foundation
import Security
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

    func testFirstRunLoginListensToRealtime() async throws {
        let app = TestApp()
        await app.session.bootstrap()
        XCTAssertEqual(app.session.phase, .signedOut)

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

    func testRealtimeMustChangePasswordStopsTheSocket() async throws {
        let app = TestApp()
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")

        app.container.realtime.dispatch(TestModels.event(#"{"type":"auth_error","code":"MUST_CHANGE_PASSWORD","message":"Требуется смена пароля"}"#))

        let changeRequired = await eventually { app.session.phase == .passwordChangeRequired }
        XCTAssertTrue(changeRequired)
        let disconnected = await eventually { await !app.realtime.isConnected }
        XCTAssertTrue(disconnected, "The socket client must not keep retrying while the password change is pending")
    }

    func testRealtimeInvalidTokenThatCannotBeRevalidatedStopsTheSocket() async throws {
        let app = TestApp()
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")
        app.auth.state.withValue { $0.currentUserResult = .failure(APIError.unauthorized) }

        app.container.realtime.dispatch(TestModels.event(#"{"type":"auth_error","code":"INVALID_TOKEN","message":"Недействительный токен авторизации"}"#))

        let signedOut = await eventually { app.session.phase == .signedOut }
        XCTAssertTrue(signedOut)
        let isConnected = await app.realtime.isConnected
        XCTAssertFalse(isConnected, "A revoked session must not leave the socket client retrying")
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
        XCTAssertEqual(app.container.conversations.channelsState, .failed("Каналы недоступны"))
        XCTAssertEqual(app.container.conversations.directState, .loaded)
        XCTAssertEqual(app.container.conversations.usersState, .loaded)
        XCTAssertEqual(app.container.announcements.loadState, .loaded)
    }
}

/// A session ends only on a definitive refusal (final review I1/I2): a launch without network, with
/// a busy server, or before the first unlock keeps it; the login name goes as typed (parity P9); the
/// registration entry follows the server's switch (decision Q).
@MainActor
final class SessionResilienceTests: XCTestCase {
    func testTheSignedInUserIsRememberedForAnOfflineLaunch() async throws {
        let app = TestApp()
        await app.session.bootstrap()

        _ = try await app.session.login(username: "qa", password: "password")

        XCTAssertEqual(app.auth.state.value.storedUser?.id, TestModels.me.id)
    }

    func testAnOfflineColdLaunchKeepsTheSessionWithTheRememberedUser() async {
        let app = TestApp()
        app.auth.state.withValue {
            $0.hasToken = true
            $0.storedUser = TestModels.me
            $0.currentUserResult = .failure(APIError.noConnection)
        }

        await app.session.bootstrap()

        XCTAssertEqual(app.session.phase, .authenticated, "the queue and the cached chats stay reachable")
        XCTAssertEqual(app.session.currentUser?.id, TestModels.me.id)
        XCTAssertTrue(app.auth.state.value.hasToken, "nothing refused the session")
        let connects = await app.realtime.connectCount
        XCTAssertGreaterThan(connects, 0, "the socket keeps trying with its backoff")
    }

    func testAServerErrorAtLaunchKeepsTheSessionToo() async {
        let app = TestApp()
        app.auth.state.withValue {
            $0.hasToken = true
            $0.storedUser = TestModels.me
            $0.currentUserResult = .failure(APIError.httpError(statusCode: 502, message: "Bad Gateway", code: nil))
        }

        await app.session.bootstrap()

        XCTAssertEqual(app.session.phase, .authenticated)
    }

    func testAnOfflineLaunchWithoutARememberedUserWaitsAndRetriesInsteadOfSigningOut() async {
        let app = TestApp()
        app.auth.state.withValue {
            $0.hasToken = true
            $0.currentUserResult = .failure(APIError.noConnection)
        }

        await app.session.bootstrap()
        XCTAssertNotEqual(app.session.phase, .signedOut, "no login screen while nothing refused the session")
        XCTAssertTrue(app.auth.state.value.hasToken)

        app.auth.state.withValue { $0.currentUserResult = .success(TestModels.me) }
        await app.session.retryRestoreIfNeeded()

        XCTAssertEqual(app.session.phase, .authenticated)
    }

    func testARevokedTokenAtAnOfflineStartStillEndsTheSessionOnceTheServerAnswers() async {
        let app = TestApp()
        app.auth.state.withValue {
            $0.hasToken = true
            $0.storedUser = TestModels.me
            $0.currentUserResult = .failure(APIError.noConnection)
        }
        await app.session.bootstrap()
        XCTAssertEqual(app.session.phase, .authenticated)

        app.auth.state.withValue { $0.currentUserResult = .failure(APIError.unauthorized) }
        app.container.realtime.dispatch(TestModels.event(#"{"type":"auth_error","code":"INVALID_TOKEN","message":"Недействительный токен авторизации"}"#))

        let signedOut = await eventually { app.session.phase == .signedOut }
        XCTAssertTrue(signedOut, "a refusal the server gave still ends it")
    }

    func testALockedKeychainAtLaunchWaitsInsteadOfWipingTheSession() async {
        let app = TestApp()
        app.auth.state.withValue {
            $0.hasToken = true
            $0.bindError = KeychainManagerError.unavailable(status: errSecInteractionNotAllowed)
        }

        await app.session.bootstrap()

        XCTAssertEqual(app.session.phase, .launching)
        XCTAssertTrue(app.auth.state.value.hasToken)
        XCTAssertEqual(app.auth.state.value.currentUserCount, 0)

        app.auth.state.withValue { $0.bindError = nil }
        await app.session.retryRestoreIfNeeded()

        XCTAssertEqual(app.session.phase, .authenticated)
    }

    func testTheLoginNameIsSentAsTypedOnlyTrimmed() async throws {
        let app = TestApp()
        await app.session.bootstrap()

        _ = try await app.session.login(username: "  Ivanov ", password: "password")

        XCTAssertEqual(app.auth.state.value.loginUsernames, ["Ivanov"], "the server compares logins case-sensitively")
    }

    func testRegistrationIsOfferedOnlyWhileTheServerTakesIt() async {
        let closed = TestApp()
        XCTAssertNil(closed.session.registrationOpen, "unknown before the server answered")
        closed.server.info.withValue { $0.allowRegistration = false }
        await closed.session.bootstrap()
        XCTAssertEqual(closed.session.registrationOpen, false)

        let open = TestApp()
        open.server.info.withValue { $0.allowRegistration = true }
        await open.session.bootstrap()
        XCTAssertEqual(open.session.registrationOpen, true)
    }

    // MARK: - Review fix round 1

    /// A session whose token is gone (a refused refresh cleared it) checks itself instead of
    /// reconnecting tokenless forever; it ends only when the server refuses it.
    func testAMissingTokenMakesTheSessionCheckItself() async throws {
        let app = TestApp()
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")
        app.auth.state.withValue { $0.currentUserResult = .failure(APIError.noConnection) }

        app.container.realtime.dispatch(TestModels.event(#"{"type":"auth_error","code":"TOKEN_MISSING","message":""}"#))
        let checked = await eventually { app.auth.state.value.currentUserCount > 1 }
        XCTAssertTrue(checked, "the session asked the server")
        XCTAssertEqual(app.session.phase, .authenticated, "no answer is not a refusal")

        app.auth.state.withValue { $0.currentUserResult = .failure(APIError.unauthorized) }
        app.container.realtime.dispatch(TestModels.event(#"{"type":"auth_error","code":"TOKEN_MISSING","message":""}"#))
        let signedOut = await eventually { app.session.phase == .signedOut }
        XCTAssertTrue(signedOut, "a refusal ends it")
    }

    /// The first launch of this version without a remembered user and without the server: never an
    /// endless blank screen — the problem is shown with «Повторить» (review fix round 1).
    func testALaunchWithoutTheServerShowsWhyAndCanBeRetried() async {
        let app = TestApp()
        app.auth.state.withValue {
            $0.hasToken = true
            $0.currentUserResult = .failure(APIError.noConnection)
        }
        await app.session.bootstrap()
        XCTAssertEqual(app.session.phase, .launching)
        XCTAssertEqual(app.session.launchProblem, "Нет связи с сервером. Проверьте подключение к интернету.")
        XCTAssertNil(app.session.errorMessage, "said on the screen, not in an alert over a blank one")

        app.auth.state.withValue { $0.currentUserResult = .failure(APIError.httpError(statusCode: 503, message: "x", code: nil)) }
        await app.session.retryRestoreIfNeeded()
        XCTAssertEqual(app.session.launchProblem, "Не удалось выполнить действие. Повторите попытку позже.")

        app.auth.state.withValue { $0.currentUserResult = .success(TestModels.me) }
        await app.session.retryRestoreIfNeeded()
        XCTAssertEqual(app.session.phase, .authenticated)
        XCTAssertNil(app.session.launchProblem)
    }

    func testTheRetryPauseGrowsAndIsCapped() {
        XCTAssertEqual(SessionStore.restoreRetryDelay(attempt: 1), 2)
        XCTAssertEqual(SessionStore.restoreRetryDelay(attempt: 3), 8)
        XCTAssertEqual(SessionStore.restoreRetryDelay(attempt: 20), 60)
    }

    /// An explicit sign-out also stops APNs for this device (as Android's Ruling U m2); a session
    /// that ends by itself does not, and the next sign-in registers again.
    func testAnExplicitSignOutUnregistersFromAPNs() async throws {
        let unregistered = Locked(0)
        let app = TestApp(unregisterForRemoteNotifications: { unregistered.withValue { $0 += 1 } })
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")

        app.auth.state.withValue { $0.currentUserResult = .failure(APIError.unauthorized) }
        app.container.realtime.dispatch(TestModels.event(#"{"type":"server_disconnect","reason":"x"}"#))
        _ = await eventually { app.session.phase == .signedOut }
        XCTAssertEqual(unregistered.value, 0, "an involuntary end keeps the registration")

        app.auth.state.withValue { $0.currentUserResult = .success(TestModels.me) }
        _ = try await app.session.login(username: "qa", password: "password")
        await app.session.logout()
        XCTAssertEqual(app.session.phase, .signedOut)
        XCTAssertEqual(unregistered.value, 1)
    }
}

