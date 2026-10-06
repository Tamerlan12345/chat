import SwiftUI

/// A ring that breathes around the caller's avatar while a call rings (scale 1 → 1.08, 1.6 s).
/// Stops when off screen; with Reduce Motion it is a still ring.
struct BreathingRing: View {
    var isActive: Bool
    var diameter: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false

    var body: some View {
        Circle()
            .strokeBorder(Color.white.opacity(0.22), lineWidth: 2)
            .background(Circle().fill(Color.white.opacity(0.05)))
            .frame(width: diameter, height: diameter)
            .scaleEffect(expanded ? 1.08 : 1)
            .opacity(expanded ? 0.55 : 1)
            .onAppear { update() }
            .onChange(of: isActive) { update() }
            .onDisappear { expanded = false }
            .accessibilityHidden(true)
    }

    private func update() {
        guard isActive, !reduceMotion else {
            withAnimation(nil) { expanded = false }
            return
        }
        withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
            expanded = true
        }
    }
}

/// A live five-bar level meter from the peer's audio RMS (`CallStore.peerLevel`).
struct LevelMeter: View {
    let level: Float
    var bars = 5

    var body: some View {
        let lit = AudioLevel.litBars(level, count: bars)
        HStack(alignment: .bottom, spacing: 4) {
            ForEach(0..<bars, id: \.self) { index in
                Capsule()
                    .fill(index < lit ? CentyColors.statusOnline : Color.white.opacity(0.22))
                    .frame(width: 5, height: 8 + CGFloat(index) * 4)
            }
        }
        .animation(.easeOut(duration: CentyMotion.fast), value: lit)
        .accessibilityElement()
        .accessibilityLabel(Text("Уровень звука собеседника"))
        .accessibilityValue(Text("\(lit) из \(bars)"))
    }
}

/// A 64-pt round call control with its label below.
struct CallControlButton: View {
    let title: LocalizedStringKey
    let systemImage: String
    var isOn = false
    var fill: Color? = nil
    var identifier: String
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            CentyHaptics.light()
            action()
        } label: {
            VStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(isOn ? Color.black : Color.white)
                    .frame(width: 64, height: 64)
                    .background(Circle().fill(fill ?? (isOn ? Color.white : CentyColors.callControl)))
                Text(title)
                    .font(.caption)
                    .foregroundStyle(Color.white.opacity(0.8))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(minWidth: 72)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle(reduceMotion: reduceMotion))
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

/// Scale 0.97 on press (none with Reduce Motion).
struct PressScaleStyle: ButtonStyle {
    let reduceMotion: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.easeOut(duration: CentyMotion.fast), value: configuration.isPressed)
    }
}

#Preview("Call stage parts") {
    VStack(spacing: 24) {
        ZStack {
            BreathingRing(isActive: true, diameter: 150)
            AvatarView(name: "Боб Тестов", size: 120)
        }
        LevelMeter(level: 0.6)
        HStack(spacing: 32) {
            CallControlButton(title: "Без звука", systemImage: "mic.slash.fill", isOn: true, identifier: "call-mute") {}
            CallControlButton(title: "Завершить", systemImage: "phone.down.fill", fill: CentyColors.dangerFill, identifier: "call-end") {}
        }
    }
    .padding(32)
    .background(CentyColors.callBackground)
}
