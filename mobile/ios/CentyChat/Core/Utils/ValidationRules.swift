import Foundation

public enum MessageAction: Sendable {
    case edit
    case delete
}

/// Бизнес-правила валидации временных окон правки и удаления сообщений
public enum ValidationRules: Sendable {
    
    /// Проверяет, разрешено ли редактирование или удаление сообщения
    /// - Parameters:
    ///   - createdAt: Дата создания сообщения
    ///   - windowMinutesStr: Настройка сервера (например "60", "0", "-1")
    ///   - isSuperAdmin: Флаг супер-администратора (может удалять всегда)
    ///   - action: Действие (.edit или .delete)
    ///   - currentTime: Текущее время (по умолчанию Date())
    /// - Returns: true, если действие разрешено
    public static func canEditOrDelete(
        createdAt: Date,
        windowMinutesStr: String?,
        isSuperAdmin: Bool = false,
        action: MessageAction,
        currentTime: Date = Date()
    ) -> Bool {
        // Суперадминистратор может удалять любые сообщения в целях модерации в любое время
        if isSuperAdmin && action == .delete {
            return true
        }
        
        let windowMinutes = Int(windowMinutesStr ?? "60") ?? 60
        
        // -1: действие отключено на сервере
        if windowMinutes == -1 {
            return false
        }
        
        // 0: без ограничений по времени
        if windowMinutes == 0 {
            return true
        }
        
        // Проверяем разницу во времени в миллисекундах
        let ageMs = currentTime.timeIntervalSince(createdAt) * 1000.0
        let maxAgeMs = Double(windowMinutes) * 60.0 * 1000.0
        
        return ageMs <= maxAgeMs
    }
}
