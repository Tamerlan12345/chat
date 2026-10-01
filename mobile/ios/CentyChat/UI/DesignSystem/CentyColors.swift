import SwiftUI
import UIKit

/// Корпоративная палитра цветов CentyChat с поддержкой Light и Dark режимов
public enum CentyColors {
    // Основные акценты бренда Centras. В тёмной теме текстовый акцент
    // светлее: это сохраняет контраст на сгруппированных системных поверхностях.
    private static func adaptive(_ light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }

    public static let primaryBlue = adaptive(
        UIColor(red: 0.357, green: 0.306, blue: 0.902, alpha: 1),
        dark: UIColor(red: 0.392, green: 0.341, blue: 0.933, alpha: 1)
    )
    public static let primaryPressed = adaptive(
        UIColor(red: 0.302, green: 0.251, blue: 0.839, alpha: 1),
        dark: UIColor(red: 0.333, green: 0.286, blue: 0.871, alpha: 1)
    )
    public static let accentText = adaptive(
        UIColor(red: 0.290, green: 0.239, blue: 0.824, alpha: 1),
        dark: UIColor(red: 0.690, green: 0.663, blue: 1.0, alpha: 1)
    )
    public static let primarySoft = adaptive(
        UIColor(red: 0.357, green: 0.306, blue: 0.902, alpha: 0.12),
        dark: UIColor(red: 0.588, green: 0.549, blue: 1.0, alpha: 0.16)
    )
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
    public static let navigationSurface = Color(uiColor: .systemBackground)
    public static let rowSeparator = Color(uiColor: .separator)
    
    // Исходящие сообщения (синий градиент/сплошной)
    public static let senderBubble = primaryBlue
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
