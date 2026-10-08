import SwiftUI

/// The system-wide buttons of the design brief («Buttons»):
/// - primary — filled `primary`, white label, 50 pt, radius 12, `headline` weight 600; pressed
///   `primary-pressed`; disabled 38 % of the fill with a dim label; loading keeps the width;
/// - tonal — `primary-soft` fill, `accentText` label, same metrics;
/// - destructive — the filled `danger-fill`, only inside a confirmation.
/// Press: scale 0.97 (none with Reduce Motion).
struct CentyButtonStyle: ButtonStyle {
    enum Kind {
        case primary
        case tonal
        case destructive
    }

    var kind: Kind = .primary
    /// A request is in flight: shown at full strength, not as disabled.
    var isBusy = false

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let enabled = isEnabled || isBusy
        configuration.label
            .font(.headline)
            .foregroundStyle(enabled ? foreground : CentyColors.textDim)
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 16)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(fill(pressed: configuration.isPressed).opacity(enabled ? 1 : 0.38))
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(.easeOut(duration: CentyMotion.fast), value: configuration.isPressed)
    }

    private var foreground: Color {
        switch kind {
        case .primary, .destructive: CentyColors.onPrimary
        case .tonal: CentyColors.accentText
        }
    }

    private func fill(pressed: Bool) -> Color {
        switch kind {
        case .primary: pressed ? CentyColors.primaryPressed : CentyColors.primaryBlue
        case .tonal: pressed ? CentyColors.primaryLine : CentyColors.primarySoft
        case .destructive: CentyColors.dangerFill
        }
    }
}

/// Text/link buttons («Отмена», «Повторить», «Очистить поиск»): `accentText`, no fill, 44 pt target.
struct CentyLinkButtonStyle: ButtonStyle {
    var tint: Color = CentyColors.accentText

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(tint)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
    }
}

/// A primary/tonal button with an optional icon and an in-place spinner while loading.
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

    private var kind: CentyButtonStyle.Kind {
        switch variant {
        case .primary: .primary
        case .secondary: .tonal
        case .destructive: .destructive
        }
    }

    public var body: some View {
        Button {
            CentyHaptics.light()
            action()
        } label: {
            ZStack {
                HStack(spacing: 8) {
                    if let icon {
                        Image(systemName: icon)
                            .accessibilityHidden(true)
                    }
                    Text(title)
                        .multilineTextAlignment(.center)
                }
                .opacity(isLoading ? 0 : 1)
                if isLoading {
                    ProgressView()
                        .tint(variant == .secondary ? CentyColors.accentText : CentyColors.onPrimary)
                }
            }
        }
        .buttonStyle(CentyButtonStyle(kind: kind, isBusy: isLoading))
        .disabled(!isEnabled || isLoading)
    }
}

#Preview("Buttons") {
    VStack(spacing: 12) {
        CentyButton(title: "Войти") {}
        CentyButton(title: "Найти сотрудника", icon: "person.2", variant: .secondary) {}
        CentyButton(title: "Войти", isLoading: true) {}
        CentyButton(title: "Войти", isEnabled: false) {}
        Button("Очистить поиск") {}
            .buttonStyle(CentyLinkButtonStyle())
    }
    .padding()
    .background(CentyColors.canvas)
}
