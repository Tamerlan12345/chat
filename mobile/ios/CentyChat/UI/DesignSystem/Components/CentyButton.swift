import SwiftUI

/// Фирменная кнопка CentyChat в стиле Apple Human Interface Guidelines
public struct CentyButton: View {
    public enum Variant {
        case primary
        case secondary
        case destructive
    }
    
    public let title: LocalizedStringKey
    public var icon: String? = nil
    public var variant: Variant = .primary
    public var isLoading: Bool = false
    public var isEnabled: Bool = true
    public let action: () -> Void
    
    public init(
        title: LocalizedStringKey,
        icon: String? = nil,
        variant: Variant = .primary,
        isLoading: Bool = false,
        isEnabled: Bool = true,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.icon = icon
        self.variant = variant
        self.isLoading = isLoading
        self.isEnabled = isEnabled
        self.action = action
    }
    
    private var backgroundColor: Color {
        guard isEnabled else { return Color.gray.opacity(0.3) }
        switch variant {
        case .primary: return CentyColors.primaryBlue
        case .secondary: return Color(uiColor: .secondarySystemFill)
        case .destructive: return CentyColors.centrasRed
        }
    }
    
    private var foregroundColor: Color {
        guard isEnabled else { return Color.gray }
        switch variant {
        case .primary, .destructive: return .white
        case .secondary: return CentyColors.primaryBlue
        }
    }
    
    public var body: some View {
        Button(action: {
            CentyHaptics.light()
            action()
        }) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: foregroundColor))
                } else if let icon = icon {
                    Image(systemName: icon)
                        .font(.body.weight(.semibold))
                }
                
                Text(title)
                    .font(.body.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(backgroundColor)
            .foregroundColor(foregroundColor)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .disabled(!isEnabled || isLoading)
    }
}
