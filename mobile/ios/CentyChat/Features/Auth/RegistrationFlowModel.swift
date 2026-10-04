import Foundation
import Observation

/// State machine of in-app registration: form -> e-mail code -> signed in / pending approval.
///
/// The password stays in memory only, is sent once per code request and is cleared as soon
/// as the flow ends (signed in or pending). Messages are fixed client copy (`AccountFailure`).
@Observable
@MainActor
public final class RegistrationFlowModel {
    public enum Step: Equatable, Sendable {
        case form
        case code
        /// The e-mail is confirmed, an administrator still has to approve the account.
        case pending
    }

    public enum Field: Hashable, Sendable {
        case email
        case displayName
        case username
        case password
    }

    /// How long «Отправить код ещё раз» stays disabled after a code was sent.
    public static let resendInterval: TimeInterval = 60

    public var email = ""
    public var displayName = ""
    public var username = ""
    public var password = ""
    public private(set) var code = ""

    public private(set) var step: Step = .form
    public private(set) var isBusy = false
    /// Field hints are shown only after the first attempt to continue.
    public private(set) var showsValidation = false
    public private(set) var failure: AccountFailure?
    public private(set) var challenge: RegistrationChallenge?
    public private(set) var codeExpiresAt: Date?
    public private(set) var resendAvailableAt: Date?

    @ObservationIgnored private let account: any AccountRepository
    @ObservationIgnored private let signIn: @MainActor (AuthSuccessResponse) async -> Void
    @ObservationIgnored private let now: @MainActor () -> Date

    public init(
        account: any AccountRepository,
        signIn: @escaping @MainActor (AuthSuccessResponse) async -> Void,
        now: @escaping @MainActor () -> Date = { Date() }
    ) {
        self.account = account
        self.signIn = signIn
        self.now = now
    }

    // MARK: - Form

    /// The first problem per field, in form order. Empty when the form can be sent.
    public var fieldErrors: [Field: String] {
        var errors: [Field: String] = [:]
        if let message = RegistrationValidation.emailError(email) { errors[.email] = message }
        if let message = RegistrationValidation.nameError(displayName) { errors[.displayName] = message }
        if let message = RegistrationValidation.usernameError(username) { errors[.username] = message }
        if let message = RegistrationValidation.passwordError(password) { errors[.password] = message }
        return errors
    }

    public func visibleError(for field: Field) -> String? {
        showsValidation ? fieldErrors[field] : nil
    }

    /// The server's answer to the last request, or nil when there is none or a wait is over.
    public func errorMessage(at date: Date) -> String? {
        failure?.message(at: date)
    }

    /// Step 1: asks the server to e-mail a code.
    public func submitForm() async {
        guard step == .form, !isBusy else { return }
        showsValidation = true
        guard fieldErrors.isEmpty else { return }
        if let deadline = failure?.retryDeadline, now() < deadline { return }
        await requestCode()
    }

    // MARK: - Code

    public func updateCode(_ raw: String) {
        code = RegistrationValidation.sanitizedCode(raw)
    }

    public var canVerify: Bool {
        step == .code && !isBusy && code.count == RegistrationValidation.codeLength
    }

    public func isCodeExpired(at date: Date) -> Bool {
        guard let codeExpiresAt else { return false }
        return date >= codeExpiresAt
    }

    /// Whole seconds until a new code may be requested; 0 when it may be requested now.
    public func secondsUntilResend(at date: Date) -> Int {
        guard let resendAvailableAt else { return 0 }
        return max(0, Int(resendAvailableAt.timeIntervalSince(date).rounded(.up)))
    }

    public func canResend(at date: Date) -> Bool {
        step == .code && !isBusy && secondsUntilResend(at: date) == 0
    }

    /// Whole seconds the current code stays valid; nil when no code was sent.
    public func secondsUntilExpiry(at date: Date) -> Int? {
        guard let codeExpiresAt else { return nil }
        return max(0, Int(codeExpiresAt.timeIntervalSince(date).rounded(.up)))
    }

    /// Asks for a fresh code with the same data.
    public func resend() async {
        guard canResend(at: now()) else { return }
        await requestCode()
    }

    /// Step 2: checks the code. Signed in -> `signIn`; otherwise the pending screen.
    public func verify() async {
        guard canVerify, let challenge else { return }
        if isCodeExpired(at: now()) {
            failure = .codeExpired
            return
        }
        isBusy = true
        defer { isBusy = false }
        failure = nil
        do {
            let outcome = try await account.verifyRegistration(registrationId: challenge.registrationId, code: code)
            switch outcome {
            case .signedIn(let auth):
                clearSecrets()
                await signIn(auth)
            case .pending:
                clearSecrets()
                step = .pending
            }
        } catch {
            let mapped = AccountFailure(error, context: .registrationVerify, now: now())
            failure = mapped
            if case .wrongCode = mapped {
                code = ""
            }
        }
    }

    /// Back to the form to fix the e-mail or any other field; the old code is dropped.
    public func backToForm() {
        guard step == .code else { return }
        step = .form
        code = ""
        failure = nil
        challenge = nil
        codeExpiresAt = nil
        resendAvailableAt = nil
    }

    // MARK: - Private

    private func requestCode() async {
        isBusy = true
        defer { isBusy = false }
        failure = nil
        let body = RegisterRequestBody(
            email: RegistrationValidation.normalizedEmail(email),
            username: RegistrationValidation.normalizedUsername(username),
            displayName: RegistrationValidation.normalizedName(displayName),
            password: password
        )
        do {
            let issued = try await account.requestRegistration(body)
            let sentAt = now()
            challenge = issued
            codeExpiresAt = sentAt.addingTimeInterval(TimeInterval(issued.expiresInSec))
            resendAvailableAt = sentAt.addingTimeInterval(Self.resendInterval)
            code = ""
            step = .code
        } catch {
            failure = AccountFailure(error, context: .registrationRequest, now: now())
        }
    }

    private func clearSecrets() {
        password = ""
        code = ""
    }
}
