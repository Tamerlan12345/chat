import SwiftUI

/// Корпоративная палитра цветов CentyChat с поддержкой Light и Dark режимов
public enum CentyColors {
    // Основные акценты бренда Centras
    public static let primaryBlue = Color(red: 0.08, green: 0.44, blue: 0.88)
    public static let centrasRed = Color(red: 0.88, green: 0.15, blue: 0.18)
    public static let centrasGold = Color(red: 0.95, green: 0.70, blue: 0.10)
    
    // Статусы присутствия
    public static let statusOnline = Color(red: 0.20, green: 0.78, blue: 0.35)
    public static let statusAway = Color(red: 1.00, green: 0.65, blue: 0.00)
    public static let statusDnd = Color(red: 0.92, green: 0.26, blue: 0.21)
    public static let statusOffline = Color(white: 0.65)
    
    // Фоны и пузыри сообщений
    public static let chatBackground = Color(uiColor: .systemGroupedBackground)
    public static let cardBackground = Color(uiColor: .secondarySystemGroupedBackground)
    
    // Исходящие сообщения (синий градиент/сплошной)
    public static let senderBubble = Color(red: 0.08, green: 0.46, blue: 0.92)
    public static let senderBubbleText = Color.white
    
    // Входящие сообщения
    public static let receiverBubble = Color(uiColor: .secondarySystemBackground)
    public static let receiverBubbleText = Color(uiColor: .label)
    
    // Приоритеты оповещений
    public static let priorityNormal = Color.secondary
    public static let priorityUrgent = Color.orange
    public static let priorityCritical = Color.red
}

public extension UserStatus {
    var color: Color {
        switch self {
        case .online: return CentyColors.statusOnline
        case .away: return CentyColors.statusAway
        case .dnd: return CentyColors.statusDnd
        case .offline: return CentyColors.statusOffline
        }
    }
}
