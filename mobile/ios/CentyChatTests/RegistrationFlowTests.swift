import Foundation
import XCTest
@testable import CentyChat

/// Scripted account backend for the state-machine tests.
final class FakeAccountRepository: AccountRepository, @unchecked Sendable {
    struct State {
        var requestResult: Result<RegistrationChallenge, any Error> =
            .success(RegistrationChallenge(status: "code_sent", registrationId: "reg-1", expiresInSec: 600))
        var verifyResult: Result<RegistrationOutcome, any Error> = .success(.pending)
        var deleteError: (any Error)?
        var reportError: (any Error)?
        var blockError: (any Error)?
        var blockedList: Result<[BlockedUser], any Error> = .success([])
        var requests: [RegisterRequestBody] = []
        var verifications: [RegisterVerifyBody] = []
        var deletePasswords: [String] = []
        var reports: [ReportBody] = []
        var blockedIds: [Int64] = []
        var unblockedIds: [Int64] = []
    }

    let state = Locked(State())

    func requestRegistration(_ body: RegisterRequestBody) async throws -> RegistrationChallenge {
        try state.withValue { state in
            state.requests.append(body)
            return try state.requestResult.get()
        }
    }

    func verifyRegistration(registrationId: String, code: String) async throws -> RegistrationOutcome {
        try state.withValue { state in
            state.verifications.append(RegisterVerifyBody(registrationId: registrationId, code: code))
            return try state.verifyResult.get()
        }
    }

    func deleteAccount(password: String) async throws {
        try state.withValue { state in
            state.deletePasswords.append(password)
            if let error = state.deleteError { throw error }
        }
    }

    func report(_ body: ReportBody) async throws {
        try state.withValue { state in
            state.reports.append(body)
            if let error = state.reportError { throw error }
        }
    }

    func blockUser(id: Int64) async throws {
        try state.withValue { state in
            if let error = state.blockError { throw error }
            state.blockedIds.append(id)
        }
    }

    func unblockUser(id: Int64) async throws {
        try state.withValue { state in
            if let error = state.blockError { throw error }
            state.unblockedIds.append(id)
        }
    }

    func blockedUsers() async throws -> [BlockedUser] {
        try state.value.blockedList.get()
    }
}

@MainActor
final class RegistrationFlowTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private var clock: Locked<Date>!
    private var account: FakeAccountRepository!
    private var signedIn: Locked<[AuthSuccessResponse]>!

    override func setUp() async throws {
        clock = Locked(t0)
        account = FakeAccountRepository()
        signedIn = Locked([])
    }

    private func makeModel() -> RegistrationFlowModel {
        let signedIn = signedIn!
        let clock = clock!
        return RegistrationFlowModel(
            account: account,
            signIn: { auth in signedIn.withValue { $0.append(auth) } },
            now: { clock.value }
        )
    }

    private func fill(_ model: RegistrationFlowModel) {
        model.email = "  Ivan@Company.KZ "
        model.displayName = "  Иван   Иванов "
        model.username = " Ivan.Petrov "
        model.password = "Str0ng-Passw0rd"
    }

    private func advance(_ seconds: TimeInterval) {
        clock.withValue { $0 = $0.addingTimeInterval(seconds) }
    }

    private func user(id: Int64 = 7) -> User {
        User(id: id, username: "ivan.petrov", fullName: "Иван Иванов")
    }

    // MARK: - Form

    func testEmptyFormShowsEveryHintAndSendsNothing() async {
        let model = makeModel()
        XCTAssertTrue(model.fieldErrors.keys.contains(.email))
        XCTAssertNil(model.visibleError(for: .email), "Hints appear only after the first attempt")

        await model.submitForm()

        XCTAssertEqual(model.step, .form)
        XCTAssertEqual(Set(model.fieldErrors.keys), [.email, .displayName, .username, .password])
        XCTAssertNotNil(model.visibleError(for: .email))
        XCTAssertTrue(account.state.value.requests.isEmpty, "An invalid form must not reach the server")
    }

    func testFieldValidationRules() {
        XCTAssertNil(RegistrationValidation.emailError("ivan@company.kz"))
        for bad in ["", "ivan", "ivan@", "@company.kz", "ivan@company", "iv an@company.kz", "a@@b.kz", "a@.kz", "a@b."] {
            XCTAssertNotNil(RegistrationValidation.emailError(bad), bad)
        }
        XCTAssertNil(RegistrationValidation.usernameError("ivan.petrov-1_x"))
        for bad in ["ab", "has space", "кириллица", "UPPER!", String(repeating: "a", count: 33)] {
            XCTAssertNotNil(RegistrationValidation.usernameError(bad), bad)
        }
        XCTAssertNil(RegistrationValidation.usernameError("  IVAN  "), "Login is trimmed and lower-cased")
        XCTAssertNil(RegistrationValidation.nameError("Иван Иванов"))
        XCTAssertNotNil(RegistrationValidation.nameError(" И "))
        XCTAssertNil(RegistrationValidation.passwordError("12345678"))
        XCTAssertNotNil(RegistrationValidation.passwordError("1234567"))
        XCTAssertNotNil(RegistrationValidation.passwordError(""))
    }

    func testCodeInputKeepsOnlySixDigits() {
        let model = makeModel()
        model.updateCode("12a 3-456789")
        XCTAssertEqual(model.code, "123456")
        model.updateCode("٣٤٥")
        XCTAssertEqual(model.code, "", "Only ASCII digits are accepted")
    }

    // MARK: - Request code

    func testValidFormRequestsACodeWithNormalizedValues() async throws {
        let model = makeModel()
        fill(model)

        await model.submitForm()

        XCTAssertEqual(model.step, .code)
        XCTAssertNil(model.failure)
        let sent = try XCTUnwrap(account.state.value.requests.first)
        XCTAssertEqual(sent.email, "ivan@company.kz")
        XCTAssertEqual(sent.displayName, "Иван Иванов")
        XCTAssertEqual(sent.username, "ivan.petrov")
        XCTAssertEqual(sent.password, "Str0ng-Passw0rd", "The password is sent as typed")
        XCTAssertEqual(model.challenge?.registrationId, "reg-1")
        XCTAssertEqual(model.codeExpiresAt, t0.addingTimeInterval(600))
        XCTAssertEqual(model.resendAvailableAt, t0.addingTimeInterval(60))
    }

    func testMailNotConfiguredIsReportedHonestlyAndStaysOnTheForm() async {
        account.state.withValue {
            $0.requestResult = .failure(APIError.httpError(statusCode: 503, message: "Отправка почты не настроена", code: nil))
        }
        let model = makeModel()
        fill(model)

        await model.submitForm()

        XCTAssertEqual(model.step, .form)
        XCTAssertEqual(model.failure, .mailNotConfigured)
        XCTAssertTrue(model.errorMessage(at: t0)?.contains("почта не настроена") == true)
        XCTAssertFalse(model.isBusy)
        XCTAssertEqual(model.password, "Str0ng-Passw0rd", "The user can retry without retyping")
    }

    func testOfflineIsReportedAsNoConnection() async {
        account.state.withValue { $0.requestResult = .failure(APIError.noConnection) }
        let model = makeModel()
        fill(model)

        await model.submitForm()

        XCTAssertEqual(model.failure, .offline)
        XCTAssertEqual(model.step, .form)
    }

    func testDuplicateLoginShowsTheServersExplanation() async {
        account.state.withValue {
            $0.requestResult = .failure(APIError.httpError(statusCode: 409, message: "Логин уже занят", code: nil))
        }
        let model = makeModel()
        fill(model)

        await model.submitForm()

        XCTAssertEqual(model.errorMessage(at: t0), "Логин уже занят")
    }

    func testThrottlingBlocksResubmissionUntilTheWaitIsOver() async {
        account.state.withValue {
            $0.requestResult = .failure(APIError.httpError(statusCode: 429, message: "x", code: nil, retryAfter: 30))
        }
        let model = makeModel()
        fill(model)
        await model.submitForm()
        XCTAssertEqual(model.failure, .throttled(until: t0.addingTimeInterval(30)))
        XCTAssertNotNil(model.errorMessage(at: t0))

        advance(10)
        await model.submitForm()
        XCTAssertEqual(account.state.value.requests.count, 1, "No second request during the wait")

        advance(25)
        XCTAssertNil(model.errorMessage(at: clock.value), "The message disappears when the wait is over")
        account.state.withValue {
            $0.requestResult = .success(RegistrationChallenge(status: "code_sent", registrationId: "reg-2", expiresInSec: 300))
        }
        await model.submitForm()
        XCTAssertEqual(account.state.value.requests.count, 2)
        XCTAssertEqual(model.step, .code)
    }

    // MARK: - Verify

    private func reachCodeStep(_ model: RegistrationFlowModel) async {
        fill(model)
        await model.submitForm()
        XCTAssertEqual(model.step, .code)
    }

    func testAllowedEmailSignsIn() async throws {
        let auth = AuthSuccessResponse(user: user(), token: "issued")
        account.state.withValue { $0.verifyResult = .success(.signedIn(auth)) }
        let model = makeModel()
        await reachCodeStep(model)
        model.updateCode("123456")

        await model.verify()

        XCTAssertEqual(signedIn.value, [auth])
        XCTAssertEqual(account.state.value.verifications, [RegisterVerifyBody(registrationId: "reg-1", code: "123456")])
        XCTAssertEqual(model.password, "", "The password is dropped once the flow ends")
        XCTAssertEqual(model.code, "")
        XCTAssertFalse(model.isBusy)
    }

    func testUnlistedEmailEndsAsPending() async {
        account.state.withValue { $0.verifyResult = .success(.pending) }
        let model = makeModel()
        await reachCodeStep(model)
        model.updateCode("123456")

        await model.verify()

        XCTAssertEqual(model.step, .pending)
        XCTAssertTrue(signedIn.value.isEmpty, "A pending account has no session")
        XCTAssertEqual(model.password, "")
    }

    func testVerifyIsDisabledUntilSixDigitsAreEntered() async {
        let model = makeModel()
        await reachCodeStep(model)
        model.updateCode("12345")
        XCTAssertFalse(model.canVerify)

        await model.verify()

        XCTAssertTrue(account.state.value.verifications.isEmpty)
        model.updateCode("123456")
        XCTAssertTrue(model.canVerify)
    }

    func testWrongCodeKeepsTheStepAndClearsTheField() async {
        account.state.withValue {
            $0.verifyResult = .failure(APIError.httpError(statusCode: 400, message: "Неверный код", code: nil))
        }
        let model = makeModel()
        await reachCodeStep(model)
        model.updateCode("000000")

        await model.verify()

        XCTAssertEqual(model.step, .code)
        XCTAssertEqual(model.failure, .wrongCode("Неверный код"))
        XCTAssertEqual(model.code, "")
        XCTAssertTrue(signedIn.value.isEmpty)
    }

    func testTooManyAttemptsAsksForANewCode() async {
        account.state.withValue {
            $0.verifyResult = .failure(APIError.httpError(statusCode: 429, message: "x", code: nil))
        }
        let model = makeModel()
        await reachCodeStep(model)
        model.updateCode("000000")

        await model.verify()

        XCTAssertEqual(model.failure, .tooManyCodeAttempts)
        XCTAssertTrue(model.errorMessage(at: t0)?.contains("новый код") == true)
    }

    func testAnExpiredCodeIsNotSentToTheServer() async {
        let model = makeModel()
        await reachCodeStep(model)
        model.updateCode("123456")
        advance(601)

        XCTAssertTrue(model.isCodeExpired(at: clock.value))
        XCTAssertEqual(model.secondsUntilExpiry(at: clock.value), 0)
        await model.verify()

        XCTAssertEqual(model.failure, .codeExpired)
        XCTAssertTrue(account.state.value.verifications.isEmpty)
    }

    // MARK: - Resend

    func testResendIsAvailableOnlyAfterTheTimer() async {
        let model = makeModel()
        await reachCodeStep(model)
        XCTAssertEqual(model.secondsUntilResend(at: clock.value), 60)
        XCTAssertFalse(model.canResend(at: clock.value))

        await model.resend()
        XCTAssertEqual(account.state.value.requests.count, 1, "Too early: nothing is sent")

        advance(59.5)
        XCTAssertEqual(model.secondsUntilResend(at: clock.value), 1)
        advance(0.5)
        XCTAssertTrue(model.canResend(at: clock.value))

        account.state.withValue {
            $0.requestResult = .success(RegistrationChallenge(status: "code_sent", registrationId: "reg-2", expiresInSec: 900))
        }
        model.updateCode("111111")
        await model.resend()

        XCTAssertEqual(account.state.value.requests.count, 2)
        XCTAssertEqual(model.challenge?.registrationId, "reg-2")
        XCTAssertEqual(model.code, "", "A new code replaces the old input")
        XCTAssertEqual(model.codeExpiresAt, clock.value.addingTimeInterval(900))
        XCTAssertEqual(model.secondsUntilResend(at: clock.value), 60)
        XCTAssertEqual(model.step, .code)
    }

    func testResendFailureStaysOnTheCodeStep() async {
        let model = makeModel()
        await reachCodeStep(model)
        advance(61)
        account.state.withValue {
            $0.requestResult = .failure(APIError.httpError(statusCode: 503, message: "Отправка почты не настроена", code: nil))
        }

        await model.resend()

        XCTAssertEqual(model.step, .code)
        XCTAssertEqual(model.failure, .mailNotConfigured)
    }

    func testBackToFormDropsTheChallenge() async {
        let model = makeModel()
        await reachCodeStep(model)
        model.updateCode("123")

        model.backToForm()

        XCTAssertEqual(model.step, .form)
        XCTAssertNil(model.challenge)
        XCTAssertEqual(model.code, "")
        XCTAssertEqual(model.email, "  Ivan@Company.KZ ", "The typed values are kept for editing")
    }

    // MARK: - Session

    func testCompletedRegistrationSignsTheSessionIn() async throws {
        let app = TestApp()
        await app.session.bootstrap()
        XCTAssertEqual(app.session.phase, .signedOut)

        await app.session.completeRegistration(AuthSuccessResponse(user: TestModels.me, token: "issued"))

        XCTAssertEqual(app.session.phase, .authenticated)
        XCTAssertEqual(app.session.currentUser?.id, TestModels.me.id)
    }
}
