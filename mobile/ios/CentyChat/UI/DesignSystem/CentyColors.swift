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
    // MARK: Design-brief tokens (desktop theme.css, light / dark)

    private static func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }

    /// `bg-main`: forms and chat background.
    public static let canvas = adaptive(rgb(0xFCFCFD), dark: rgb(0x24242A))
    /// Cards and incoming bubbles.
    public static let card = adaptive(rgb(0xFFFFFF), dark: rgb(0x2B2B32))
    /// Hairlines instead of shadows.
    public static let border = adaptive(rgb(0x181838, 0.10), dark: rgb(0xFFFFFF, 0.085))
    public static let fieldBackground = adaptive(rgb(0xFCFCFD), dark: rgb(0x24242A))
    public static let textStrong = adaptive(rgb(0x16161D), dark: rgb(0xF4F4F7))
    public static let textMain = adaptive(rgb(0x2B2B34), dark: rgb(0xDFDFE5))
    public static let textSecondary = adaptive(rgb(0x4A4A55), dark: rgb(0xBDBDC7))
    public static let textDim = adaptive(rgb(0x686874), dark: rgb(0x9898A4))
    public static let onPrimary = Color.white
    public static let dangerText = adaptive(rgb(0xB4232A), dark: rgb(0xFF8F8F))
    public static let dangerSoft = adaptive(rgb(0xD9363B, 0.08), dark: rgb(0xE5484D, 0.14))
    public static let dangerLine = adaptive(rgb(0xD9363B, 0.30), dark: rgb(0xE5484D, 0.40))

    /// Brand gradient, 135°: only for the C mark.
    public static let brandGradient = LinearGradient(
        stops: [
            .init(color: Color(uiColor: rgb(0xEC8EE0)), location: 0),
            .init(color: Color(uiColor: rgb(0xC078EE)), location: 0.2),
            .init(color: Color(uiColor: rgb(0x7C44EA)), location: 0.45),
            .init(color: Color(uiColor: rgb(0x2A72EE)), location: 0.75),
            .init(color: Color(uiColor: rgb(0x00DAFF)), location: 1),
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
    /// Subtle light rim around the mark.
    public static let brandRim = LinearGradient(
        stops: [
            .init(color: Color.white.opacity(0.55), location: 0),
            .init(color: Color.white.opacity(0.06), location: 0.6),
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
    public static let brandGlyph = Color.white

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
