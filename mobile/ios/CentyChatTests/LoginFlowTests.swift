import Foundation
import XCTest
@testable import CentyChat

/// Login errors never reveal whether a login exists, and throttling turns into a countdown
/// instead of a retry loop.
final class LoginErrorMappingTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)
    private let invalidCredentials = "Неверный логин или пароль"

    func testWrongPasswordIsGenericAndHidesTheServerText() {
        let error = APIError.httpError(
            statusCode: 400,
            message: "Пользователь alice не найден",
            code: "INVALID_CREDENTIALS"
        )
        let failure = LoginFailure(error, now: now)

        XCTAssertEqual(failure, .invalidCredentials)
        XCTAssertEqual(failure.message(at: now), invalidCredentials)
    }

    func testUnauthorizedIsGeneric() {
        XCTAssertEqual(LoginFailure(APIError.httpError(statusCode: 401, message: "x", code: nil), now: now), .invalidCredentials)
        XCTAssertEqual(LoginFailure(APIError.unauthorized, now: now).message(at: now), invalidCredentials)
    }

    func testThrottlingCountsDownFromRetryAfter() {
        let error = APIError.httpError(statusCode: 429, message: "x", code: "ACCOUNT_THROTTLED", retryAfter: 42)
        let failure = LoginFailure(error, now: now)

        XCTAssertEqual(failure, .throttled(until: now.addingTimeInterval(42)))
        XCTAssertEqual(failure.message(at: now), "Слишком много попыток входа. Повторите через 42 с.")
        XCTAssertEqual(failure.message(at: now.addingTimeInterval(12)), "Слишком много попыток входа. Повторите через 30 с.")
        XCTAssertNil(failure.message(at: now.addingTimeInterval(42)), "The message disappears when the wait is over")
    }

    func testThrottlingWithoutRetryAfterWaitsAMinute() {
        let failure = LoginFailure(APIError.httpError(statusCode: 429, message: "x", code: nil), now: now)

        XCTAssertEqual(failure, .throttled(until: now.addingTimeInterval(60)))
        XCTAssertEqual(failure.message(at: now), "Слишком много попыток входа. Повторите через 1 мин.")
    }

    func testLongThrottlingShowsMinutesAndSeconds() {
        let failure = LoginFailure(APIError.httpError(statusCode: 429, message: "x", code: "ACCOUNT_THROTTLED", retryAfter: 150), now: now)

        XCTAssertEqual(failure.message(at: now), "Слишком много попыток входа. Повторите через 2 мин 30 с.")
    }

    func testBusyServerCountsDown() {
        let error = APIError.httpError(statusCode: 503, message: "x", code: "LOGIN_BUSY", retryAfter: 3)
        let failure = LoginFailure(error, now: now)

        XCTAssertEqual(failure, .serverBusy(until: now.addingTimeInterval(3)))
        XCTAssertEqual(failure.message(at: now), "Сервер сейчас занят. Повторите через 3 с.")
    }

    func testOfflineIsExplained() {
        let failure = LoginFailure(APIError.noConnection, now: now)

        XCTAssertEqual(failure, .offline)
        XCTAssertEqual(failure.message(at: now), "Нет связи с сервером. Проверьте подключение к интернету.")
        XCTAssertNil(failure.retryDeadline)
    }

    func testUnexpectedServerErrorsAreGeneric() {
        let failure = LoginFailure(APIError.httpError(statusCode: 500, message: "SQLITE_BUSY at db.js:12", code: nil), now: now)

        XCTAssertEqual(failure, .unavailable)
        XCTAssertEqual(failure.message(at: now), "Не удалось войти. Повторите попытку позже.")
    }
}

/// `Retry-After` is read from the response, in seconds or as an HTTP date.
final class RetryAfterTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    func testSecondsAndDates() {
        XCTAssertEqual(RetryAfter.seconds(from: "42", now: now), 42)
        XCTAssertEqual(RetryAfter.seconds(from: " 7 ", now: now), 7)
        XCTAssertNil(RetryAfter.seconds(from: nil, now: now))
        XCTAssertNil(RetryAfter.seconds(from: "-5", now: now))
        XCTAssertNil(RetryAfter.seconds(from: "soon", now: now))
        // 1_790_000_030 = Mon, 21 Sep 2026 14:13:50 GMT
        XCTAssertEqual(RetryAfter.seconds(from: "Mon, 21 Sep 2026 14:13:50 GMT", now: now), 30)
        XCTAssertEqual(RetryAfter.seconds(from: "999999999", now: now), RetryAfter.maximum)
    }

    func testThrottledLoginCarriesRetryAfter() async {
        RecordingURLProtocol.reset(routes: [
            "/api/auth/login": .init(
                status: 429,
                headers: ["Retry-After": "17"],
                body: #"{"error":"Слишком много неудачных попыток","code":"ACCOUNT_THROTTLED"}"#
            ),
        ])
        let keychain = KeychainManager(testStore: SeededKeychainItemStore())
        let client = APIClient(session: RecordingURLProtocol.session(), keychain: keychain, environment: .test)

        do {
            _ = try await client.login(request: LoginRequest(username: "alice", password: "wrong"))
            XCTFail("A throttled login must throw")
        } catch APIError.httpError(let status, _, let code, let retryAfter) {
            XCTAssertEqual(status, 429)
            XCTAssertEqual(code, "ACCOUNT_THROTTLED")
            XCTAssertEqual(retryAfter, 17)
        } catch {
            XCTFail("Unexpected error \(error)")
        }
        XCTAssertNil(keychain.authToken)
    }
}

@MainActor
final class LoginFormModelTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_790_000_000)

    private func makeModel() -> LoginFormModel {
        LoginFormModel(now: { [unowned self] in self.clock })
    }

    func testSubmitNeedsBothFields() {
        let model = makeModel()
        XCTAssertFalse(model.canSubmit(at: clock))
        model.username = "alice"
        XCTAssertFalse(model.canSubmit(at: clock))
        model.password = "secret"
        XCTAssertTrue(model.canSubmit(at: clock))
        model.username = "   "
        XCTAssertFalse(model.canSubmit(at: clock))
    }

    func testSecondSubmitWhileSigningInIsIgnored() async {
        let model = makeModel()
        model.username = "alice"
        model.password = "secret"
        let gate = TestGate()
        let calls = Locked(0)

        let first = Task { @MainActor in
            await model.submit { _, _ in
                calls.withValue { $0 += 1 }
                await gate.wait()
                return .authenticated
            }
        }
        let started = await eventually { model.isSubmitting }
        XCTAssertTrue(started)
        XCTAssertFalse(model.canSubmit(at: clock), "The button is disabled while the request is in flight")

        let second = await model.submit { _, _ in
            calls.withValue { $0 += 1 }
            return .authenticated
        }
        await gate.open()
        let firstOutcome = await first.value

        XCTAssertNil(second)
        XCTAssertEqual(firstOutcome, .authenticated)
        XCTAssertEqual(calls.value, 1, "Only one login request may be sent")
        XCTAssertFalse(model.isSubmitting)
    }

    func testThrottlingBlocksSubmitUntilTheCountdownEnds() async {
        let model = makeModel()
        model.username = "alice"
        model.password = "wrong"
        let start = clock

        let outcome = await model.submit { _, _ in
            throw APIError.httpError(statusCode: 429, message: "x", code: "ACCOUNT_THROTTLED", retryAfter: 30)
        }

        XCTAssertNil(outcome)
        XCTAssertFalse(model.canSubmit(at: start.addingTimeInterval(10)))
        XCTAssertEqual(model.errorMessage(at: start.addingTimeInterval(10)), "Слишком много попыток входа. Повторите через 20 с.")
        XCTAssertTrue(model.canSubmit(at: start.addingTimeInterval(30)))
        XCTAssertNil(model.errorMessage(at: start.addingTimeInterval(30)))

        clock = start.addingTimeInterval(5)
        let early = await model.submit { _, _ in
            XCTFail("No request may be sent during the countdown")
            return .authenticated
        }
        XCTAssertNil(early)
    }

    func testFailedLoginShowsTheGenericMessage() async {
        let model = makeModel()
        model.username = "alice"
        model.password = "wrong"

        await model.submit { _, _ in
            throw APIError.httpError(statusCode: 400, message: "Пользователь заблокирован", code: "INVALID_CREDENTIALS")
        }

        XCTAssertEqual(model.errorMessage(at: clock), "Неверный логин или пароль")
        XCTAssertTrue(model.canSubmit(at: clock), "A wrong password can be corrected right away")
    }

    func testSuccessForgetsThePasswordAndKeepsTheLogin() async {
        let model = makeModel()
        model.username = "alice"
        model.password = "secret"

        let outcome = await model.submit { username, password in
            XCTAssertEqual(username, "alice")
            XCTAssertEqual(password, "secret")
            return .authenticated
        }

        XCTAssertEqual(outcome, .authenticated)
        XCTAssertEqual(model.password, "")
        XCTAssertEqual(model.username, "alice")
        XCTAssertNil(model.errorMessage(at: clock))
    }

    func testLastLoginNameIsPrefilledOnce() {
        let model = makeModel()
        model.prefill(username: "alice")
        XCTAssertEqual(model.username, "alice")

        model.username = "bob"
        model.prefill(username: "alice")
        XCTAssertEqual(model.username, "bob")
    }
}

@MainActor
final class SessionLoginTests: XCTestCase {
    func testFirstLaunchGoesStraightToLogin() async {
        let app = TestApp()
        XCTAssertEqual(app.session.phase, .signedOut, "A fresh install shows login without a loading or setup step")

        await app.session.bootstrap()

        XCTAssertEqual(app.session.phase, .signedOut)
        let connects = await app.realtime.connectCount
        XCTAssertEqual(connects, 0)
    }

    func testConcurrentLoginIsSentOnce() async throws {
        let app = TestApp()
        await app.session.bootstrap()
        let gate = TestGate()
        app.auth.state.withValue { $0.loginGate = gate }

        let first = Task { @MainActor in
            try await app.session.login(username: "alice", password: "secret")
        }
        let started = await eventually { app.session.isSigningIn }
        XCTAssertTrue(started)

        // Run the second attempt concurrently so a missing guard fails instead of deadlocking.
        let second = Task { @MainActor in
            try await app.session.login(username: "alice", password: "secret")
        }
        await settle()
        await gate.open()
        let outcome = try await first.value
        let secondResult = await second.result

        XCTAssertEqual(outcome, .authenticated)
        switch secondResult {
        case .failure(SessionError.loginInProgress):
            break
        default:
            XCTFail("A second login while one is in flight must be refused, got \(secondResult)")
        }
        XCTAssertEqual(app.auth.state.value.loginCount, 1, "Only one login request may be sent")
        XCTAssertFalse(app.session.isSigningIn)
    }

    func testForeignHostSessionIsWipedAndLandsOnLogin() async {
        let app = TestApp()
        app.auth.state.withValue {
            $0.hasToken = true
            $0.hasDeviceSecret = true
            $0.issuerOrigin = "https://chat.old-company.kz"
        }

        await app.session.bootstrap()

        XCTAssertEqual(app.session.phase, .signedOut)
        let state = app.auth.state.value
        XCTAssertFalse(state.hasToken)
        XCTAssertFalse(state.hasDeviceSecret)
        XCTAssertEqual(state.currentUserCount, 0, "The foreign token must not be validated against this server")
        let connects = await app.realtime.connectCount
        XCTAssertEqual(connects, 0)
    }

    func testCredentialWipeFailureFailsClosed() async {
        let app = TestApp()
        app.auth.state.withValue {
            $0.hasToken = true
            $0.issuerOrigin = "https://chat.old-company.kz"
            $0.bindError = KeychainManagerError.deleteFailed(status: -25308)
        }

        await app.session.bootstrap()

        XCTAssertEqual(app.session.phase, .signedOut)
        let state = app.auth.state.value
        XCTAssertEqual(state.currentUserCount, 0)
        XCTAssertEqual(state.knockCount, 0)
    }
}
