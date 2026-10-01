import Foundation

/// Направление звонка
public enum CallDirection: String, Codable, Sendable {
    case incoming
    case outgoing
}

/// Стейт-машина голосового вызова CentyChat
public enum CallState: String, Codable, Sendable, Equatable {
    case idle
    case calling       // Исходящий вызов (гудки)
    case ringing       // Входящий вызов (звонок)
    case connecting    // Принят, инициализация AudioRelay
    case active        // Активный разговор
    case ended         // Завершен штатно
    case failed        // Ошибка (отклонен, недоступен, таймаут)
    
    public var isTerminal: Bool {
        self == .idle || self == .ended || self == .failed
    }
    
    public var descriptionRu: String {
        switch self {
        case .idle: return "Готов к вызову"
        case .calling: return "Вызов..."
        case .ringing: return "Входящий звонок..."
        case .connecting: return "Соединение..."
        case .active: return "Идет разговор"
        case .ended: return "Звонок завершен"
        case .failed: return "Вызов не удался"
        }
    }
}

/// Причина завершения или сбоя звонка
public enum CallEndReason: String, Codable, Sendable {
    case normal = "Разговор завершен"
    case rejected = "Вызов отклонен"
    case unavailable = "Собеседник занят или недоступен"
    case denied = "Звонки запрещены политикой безопасности"
    case timeout = "Собеседник не отвечает"
    case connectionLost = "Связь потеряна"
    case micPermissionDenied = "Нет доступа к микрофону"
}

/// Сессия голосового звонка 1-на-1
public struct CallSession: Identifiable, Codable, Sendable, Equatable {
    public var id: String { "\(peerId)_\(direction.rawValue)" }
    public var peerId: Int64
    public var peerName: String
    public var peerAvatar: String?
    public var state: CallState
    public var direction: CallDirection
    public var startedAt: Date?
    public var duration: TimeInterval
    public var isMuted: Bool
    public var isSpeakerOn: Bool
    public var endReason: CallEndReason?
    
    public init(
        peerId: Int64,
        peerName: String,
        peerAvatar: String? = nil,
        state: CallState = .idle,
        direction: CallDirection = .outgoing,
        startedAt: Date? = nil,
        duration: TimeInterval = 0,
        isMuted: Bool = false,
        isSpeakerOn: Bool = false,
        endReason: CallEndReason? = nil
    ) {
        self.peerId = peerId
        self.peerName = peerName
        self.peerAvatar = peerAvatar
        self.state = state
        self.direction = direction
        self.startedAt = startedAt
        self.duration = duration
        self.isMuted = isMuted
        self.isSpeakerOn = isSpeakerOn
        self.endReason = endReason
    }
    
    /// Форматированная строка продолжительности разговора (например "03:45")
    public var formattedDuration: String {
        let totalSeconds = Int(duration)
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }
}
