import Foundation

/// Why registration, account deletion, a report or a block failed, as shown to the user.
///
/// Texts are fixed Russian client copy. The server's own message is shown only where it
/// explains how to fix the input (validation, duplicates, a wrong code).
public enum AccountFailure: Equatable, Sendable {
    public enum Context: Sendable {
        case registrationRequest
        case registrationVerify
        case deleteAccount
        case generic
    }

    case offline
    /// The server cannot send the confirmation e-mail (`503`, mail is not configured).
    case mailNotConfigured
    case throttled(until: Date)
    /// `400` while requesting a code: the server explains what to fix.
    case invalidInput(String)
    /// `409`: the login or e-mail is taken.
    case conflict(String)
    /// A wrong e-mail code; `attemptsLeft` when the server says how many tries remain.
    case wrongCode(String, attemptsLeft: Int?)
    /// The code expired, was used, ran out of attempts or the registration is unknown
    /// (the server does not tell these apart).
    case codeExpired
    /// `503 EMAIL_SEND_FAILED`: mail is configured but sending failed.
    case mailSendFailed
    case wrongPassword
    /// 400 LAST_ADMIN: the only administrator cannot delete the account.
    case lastAdmin
    case unavailable

    static let defaultThrottleWait: TimeInterval = 60
    /// `503` codes of a busy server (`BUSY` — no free password-hash slot): a short wait, as on Android.
    static let busyCodes: Set<String> = ["PASSWORD_HASH_BUSY", "LOGIN_BUSY", "BUSY"]
    static let messageLimit = 200

    init(_ error: any Error, context: Context, now: Date) {
        switch error {
        case let apiError as APIError:
            self = Self.classify(apiError, context: context, now: now)
        case is URLError:
            self = .offline
        default:
            self = .unavailable
        }
    }

    private static func classify(_ error: APIError, context: Context, now: Date) -> AccountFailure {
        switch error {
        case .noConnection:
            return .offline
        case .unauthorized:
            return context == .deleteAccount ? .wrongPassword : .unavailable
        case .rejectedWithAttempts(let status, let message, let code, let attemptsLeft):
            guard context == .registrationVerify else { return .unavailable }
            if status == 410 || code == "CODE_EXPIRED" { return .codeExpired }
            return .wrongCode(clean(message), attemptsLeft: attemptsLeft)
        case .httpError(let status, let message, let code, let retryAfter):
            let throttle = now.addingTimeInterval(retryAfter ?? defaultThrottleWait)
            switch context {
            case .registrationRequest:
                switch status {
                case 400, 422: return .invalidInput(clean(message))
                case 409: return .conflict(conflictText(code: code, message: message))
                case 429: return .throttled(until: throttle)
                case 503:
                    // A busy password hasher is a short wait; anything else is the missing mail setup.
                    if let code, busyCodes.contains(code) {
                        return .throttled(until: now.addingTimeInterval(retryAfter ?? 5))
                    }
                    if code == "EMAIL_SEND_FAILED" { return .mailSendFailed }
                    return .mailNotConfigured
                default: return .unavailable
                }
            case .registrationVerify:
                if code == "CODE_EXPIRED" { return .codeExpired }
                switch status {
                case 400, 401, 403, 422: return .wrongCode(clean(message), attemptsLeft: nil)
                case 404, 410: return .codeExpired
                case 409: return .conflict(conflictText(code: code, message: message))
                case 429: return .throttled(until: throttle)
                default: return .unavailable
                }
            case .deleteAccount:
                if code == "LAST_ADMIN" { return .lastAdmin }
                switch status {
                case 400, 401, 403: return .wrongPassword
                case 429: return .throttled(until: throttle)
                default: return .unavailable
                }
            case .generic:
                return status == 429 ? .throttled(until: throttle) : .unavailable
            }
        default:
            return .unavailable
        }
    }

    /// `USERNAME_TAKEN` / `EMAIL_TAKEN` get fixed copy; any other 409 keeps the server's text.
    static func conflictText(code: String?, message: String) -> String {
        switch code {
        case "USERNAME_TAKEN": return String(localized: "Этот логин уже занят. Выберите другой.")
        case "EMAIL_TAKEN": return String(localized: "На этот адрес почты уже подана заявка или есть аккаунт.")
        default: return clean(message)
        }
    }

    /// Plain single-line text from the server, capped.
    static func clean(_ raw: String) -> String {
        let collapsed = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard collapsed.count > messageLimit else { return collapsed }
        return String(collapsed.prefix(messageLimit - 1)) + "…"
    }

    var retryDeadline: Date? {
        if case .throttled(let until) = self { return until }
        return nil
    }

    /// The text for the error box at `date`, or nil once a wait is over.
    func message(at date: Date) -> String? {
        switch self {
        case .offline:
            return String(localized: "Нет связи с сервером. Проверьте подключение к интернету.")
        case .mailNotConfigured:
            return String(localized: "Сервер пока не может отправить письмо с кодом: почта не настроена. Регистрация временно недоступна — обратитесь к администратору.")
        case .throttled(let until):
            let total = Int(until.timeIntervalSince(date).rounded(.up))
            guard total > 0 else { return nil }
            return String(localized: "Слишком много попыток. Повторите через \(total) с.")
        case .invalidInput(let text):
            return text.isEmpty ? String(localized: "Проверьте введённые данные.") : text
        case .conflict(let text):
            return text.isEmpty ? String(localized: "Такой логин или адрес почты уже зарегистрирован.") : text
        case .wrongCode(let text, let attemptsLeft):
            var base = text.isEmpty ? String(localized: "Неверный код. Проверьте письмо и попробуйте ещё раз.") : text
            while base.hasSuffix(".") { base.removeLast() }
            guard let attemptsLeft else { return base + "." }
            return base + String(localized: ". Осталось попыток: \(attemptsLeft).")
        case .codeExpired:
            return String(localized: "Код недействителен: срок истёк, он уже использован или попытки закончились. Запросите новый код.")
        case .mailSendFailed:
            return String(localized: "Не удалось отправить письмо с кодом. Повторите попытку позже.")
        case .wrongPassword:
            return String(localized: "Неверный пароль.")
        case .lastAdmin:
            return String(localized: "Вы — единственный администратор. Назначьте другого администратора, затем удалите аккаунт.")
        case .unavailable:
            return String(localized: "Не удалось выполнить действие. Повторите попытку позже.")
        }
    }
}

/// Client-side checks for the registration form. Mirrors the server's visible rules
/// (password of at least 8 characters); the server remains the authority.
public enum RegistrationValidation {
    public static let codeLength = 6
    public static let passwordMinLength = 8
    public static let usernameRange = 3...64

    public static func normalizedEmail(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    public static func normalizedUsername(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    public static func normalizedName(_ raw: String) -> String {
        raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    public static func emailError(_ raw: String) -> String? {
        let email = normalizedEmail(raw)
        guard !email.isEmpty else { return String(localized: "Укажите адрес эл. почты") }
        let parts = email.split(separator: "@", omittingEmptySubsequences: false)
        guard email.count <= 254, parts.count == 2, !parts[0].isEmpty,
              !email.contains(where: \.isWhitespace),
              let domain = parts.last, domain.contains("."),
              !domain.hasPrefix("."), !domain.hasSuffix(".") else {
            return String(localized: "Введите корректный адрес эл. почты")
        }
        return nil
    }

    public static func nameError(_ raw: String) -> String? {
        let name = normalizedName(raw)
        guard name.count >= 2 else { return String(localized: "Укажите ФИО (не короче 2 символов)") }
        guard name.count <= 100 else { return String(localized: "ФИО слишком длинное") }
        return nil
    }

    public static func usernameError(_ raw: String) -> String? {
        let username = normalizedUsername(raw)
        guard usernameRange.contains(username.count) else {
            return String(localized: "Логин: от 3 до 64 символов")
        }
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789._-")
        guard username.allSatisfy({ allowed.contains($0) }) else {
            return String(localized: "Логин: латинские буквы, цифры, точка, дефис и подчёркивание")
        }
        return nil
    }

    public static func passwordError(_ password: String) -> String? {
        guard !password.isEmpty else { return String(localized: "Придумайте пароль") }
        guard password.count >= passwordMinLength else {
            return String(localized: "Пароль: не короче 8 символов")
        }
        guard password.utf8.count <= 1024 else { return String(localized: "Пароль слишком длинный") }
        return nil
    }

    /// Digits only, at most `codeLength`.
    public static func sanitizedCode(_ raw: String) -> String {
        String(raw.filter { $0.isASCII && $0.isNumber }.prefix(codeLength))
    }
}
