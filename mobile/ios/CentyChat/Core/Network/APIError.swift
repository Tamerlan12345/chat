import Foundation

/// Ошибки сетевого взаимодействия CentyChat
public enum APIError: Error, LocalizedError, Sendable {
    case invalidURL(String)
    case insecureTransport
    case invalidResponse
    case httpError(statusCode: Int, message: String, code: String?)
    case mustChangePassword(message: String)
    case unauthorized
    case decodingError(String)
    case noConnection
    case custom(String)
    
    public var errorDescription: String? {
        switch self {
        case .invalidURL(let url):
            return "Неверный URL сервера: \(url)"
        case .insecureTransport:
            return "A secure connection is required to protect the session."
        case .invalidResponse:
            return "Некорректный ответ от сервера"
        case .httpError(let statusCode, let message, _):
            return "Ошибка сервера (\(statusCode)): \(message)"
        case .mustChangePassword(let message):
            return message
        case .unauthorized:
            return "Сессия истекла. Пожалуйста, выполните вход заново."
        case .decodingError(let detail):
            return "Ошибка обработки данных: \(detail)"
        case .noConnection:
            return "Нет подключения к серверу. Проверьте интернет или адрес сервера."
        case .custom(let message):
            return message
        }
    }
}
