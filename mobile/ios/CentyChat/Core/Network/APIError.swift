import Foundation

/// Ошибки сетевого взаимодействия CentyChat
public enum APIError: Error, LocalizedError, Sendable {
    case invalidURL(String)
    case insecureTransport
    case invalidResponse
    /// `retryAfter` is the server's `Retry-After` in seconds, when it sent one.
    case httpError(statusCode: Int, message: String, code: String?, retryAfter: TimeInterval? = nil)
    /// A refusal that says how many attempts remain (a wrong registration code).
    case rejectedWithAttempts(statusCode: Int, message: String, code: String?, attemptsLeft: Int)
    case mustChangePassword(message: String)
    case unauthorized
    case decodingError(String)
    case noConnection
    case custom(String)
    
    public var errorDescription: String? {
        switch self {
        case .invalidURL(let url):
            return String(localized: "Неверный URL сервера: \(url)")
        case .insecureTransport:
            return String(localized: "Для защиты сессии требуется защищённое соединение (HTTPS).")
        case .invalidResponse:
            return String(localized: "Некорректный ответ от сервера")
        case .httpError(let statusCode, let message, _, _):
            return String(localized: "Ошибка сервера (\(statusCode)): \(message)")
        case .rejectedWithAttempts(let statusCode, let message, _, _):
            return String(localized: "Ошибка сервера (\(statusCode)): \(message)")
        case .mustChangePassword(let message):
            return message
        case .unauthorized:
            return String(localized: "Сессия истекла. Пожалуйста, выполните вход заново.")
        case .decodingError(let detail):
            return String(localized: "Ошибка обработки данных: \(detail)")
        case .noConnection:
            return String(localized: "Нет подключения к серверу. Проверьте интернет или адрес сервера.")
        case .custom(let message):
            return message
        }
    }
}
