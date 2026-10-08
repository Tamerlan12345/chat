import SwiftUI
import UIKit

/// The design tokens of the desktop (`desktop/src/renderer/src/styles/theme.css`), light and dark.
/// Views use these names only — no raw hex, no system colours that drift from the desktop.
///
/// Depth («наслоенность»), four planes: L0 `frame` (tab/nav bar tint), L1 `list` (inbox, grouped
/// lists), L2 `canvas` (chat, forms), L3 `elevated` (composer, sheets, menus, banners, date pill).
public enum CentyColors {
    private static func adaptive(_ light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }

    private static func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }

    // MARK: Planes

    /// L0 `bg-rail`: the deepest frame.
    public static let frame = adaptive(rgb(0xECECF1), dark: rgb(0x19191E))
    /// L1 `bg-sidebar`: inbox and grouped lists.
    public static let list = adaptive(rgb(0xF4F4F7), dark: rgb(0x1E1E24))
    /// L2 `bg-main`: chat and forms.
    public static let canvas = adaptive(rgb(0xFCFCFD), dark: rgb(0x24242A))
    /// `bg-card`: rows of grouped lists, incoming bubbles.
    public static let card = adaptive(rgb(0xFFFFFF), dark: rgb(0x2B2B32))
    /// L3 `bg-elevated`: sheets, menus, banners, the composer.
    public static let elevated = adaptive(rgb(0xFFFFFF), dark: rgb(0x303038))
    /// `bg-sunken`: filled fields, quiet pills, skeletons.
    public static let sunken = adaptive(rgb(0x181838, 0.045), dark: rgb(0x000000, 0.20))
    /// Overlay scrim.
    public static let scrim = adaptive(rgb(0x141428, 0.34), dark: rgb(0x08080C, 0.64))

    // MARK: Lines

    /// Hairlines instead of shadows.
    public static let border = adaptive(rgb(0x181838, 0.10), dark: rgb(0xFFFFFF, 0.085))
    public static let borderStrong = adaptive(rgb(0x181838, 0.17), dark: rgb(0xFFFFFF, 0.15))

    // MARK: Text

    public static let textStrong = adaptive(rgb(0x16161D), dark: rgb(0xF4F4F7))
    public static let textMain = adaptive(rgb(0x2B2B34), dark: rgb(0xDFDFE5))
    public static let textSecondary = adaptive(rgb(0x4A4A55), dark: rgb(0xBDBDC7))
    public static let textDim = adaptive(rgb(0x686874), dark: rgb(0x9898A4))
    public static let onPrimary = Color.white

    // MARK: Accent

    public static let primaryBlue = adaptive(rgb(0x5B4EE6), dark: rgb(0x6457EE))
    public static let primaryPressed = adaptive(rgb(0x4336C2), dark: rgb(0x5549DE))
    public static let primarySoft = adaptive(rgb(0x5B4EE6, 0.10), dark: rgb(0x968CFF, 0.16))
    public static let primaryLine = adaptive(rgb(0x5B4EE6, 0.30), dark: rgb(0x968CFF, 0.40))
    /// Own bubble text, links, accents on soft fills.
    public static let accentText = adaptive(rgb(0x4A3DD2), dark: rgb(0xB0A9FF))
    /// Own bubble: `primary-soft` over the canvas.
    public static let ownBubble = primarySoft

    // MARK: Feedback

    public static let danger = adaptive(rgb(0xD9363B), dark: rgb(0xE5484D))
    public static let dangerText = adaptive(rgb(0xB4232A), dark: rgb(0xFF8F8F))
    public static let dangerSoft = adaptive(rgb(0xD9363B, 0.08), dark: rgb(0xE5484D, 0.14))
    public static let dangerLine = adaptive(rgb(0xD9363B, 0.30), dark: rgb(0xE5484D, 0.40))
    /// Filled destructive buttons (end call, confirmations).
    public static let dangerFill = Color(uiColor: rgb(0xC9302C))
    public static let success = adaptive(rgb(0x1F9D61), dark: rgb(0x3FB97A))
    public static let successText = adaptive(rgb(0x137446), dark: rgb(0x6FD9A2))
    public static let successSoft = adaptive(rgb(0x1F9D61, 0.10), dark: rgb(0x3FB97A, 0.14))
    public static let successFill = Color(uiColor: rgb(0x1A7F45))
    public static let warning = adaptive(rgb(0xC98212), dark: rgb(0xE5A13A))
    public static let warningText = adaptive(rgb(0x8A5700), dark: rgb(0xF3C26F))
    public static let warningSoft = adaptive(rgb(0xC98212, 0.10), dark: rgb(0xE5A13A, 0.14))

    // MARK: Presence (dots only)

    public static let statusOnline = adaptive(rgb(0x2DA44E), dark: rgb(0x3FB950))
    public static let statusAway = adaptive(rgb(0xD4951C), dark: rgb(0xE5A13A))
    public static let statusDnd = adaptive(rgb(0xD9363B), dark: rgb(0xE5484D))
    public static let statusOffline = adaptive(rgb(0x9A9AA6), dark: rgb(0x7D7D89))

    /// Channel avatars: a slate tile.
    public static let channelSlate = adaptive(rgb(0x475569), dark: rgb(0x3A3F4B))

    // MARK: Call stage (dark whatever the theme, like the desktop call panels)

    public static let callBackground = Color(uiColor: rgb(0x19191E))
    public static let callControl = Color(uiColor: rgb(0xFFFFFF, 0.14))

    // MARK: Brand (only the C mark)

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
