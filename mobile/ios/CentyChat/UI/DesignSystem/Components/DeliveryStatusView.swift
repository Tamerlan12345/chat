import SwiftUI

/// The state of an own message (`delivery-state.md` §3.4), the product's signature ("the message
/// lands"): a custom-drawn glyph that *draws itself* through queued (clock) → sending (arrow) →
/// sent (✓) → delivered (✓✓) → read (✓✓ indigo), 160 ms per state. Failed becomes a red ⟲ with a
/// single 4-pt shake and a warning haptic. Reduce Motion: instant swap, colour only; the haptic stays.
struct DeliveryStatusView: View {
    let mark: DeliveryMark

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .caption2) private var height: CGFloat = 10
    @State private var drawn: CGFloat = 1
    @State private var shakes = 0

    init(mark: DeliveryMark) {
        self.mark = mark
    }

    var body: some View {
        DeliveryGlyphShape(mark: mark)
            .trim(from: 0, to: drawn)
            .stroke(color, style: StrokeStyle(lineWidth: max(1.2, height * 0.14), lineCap: .round, lineJoin: .round))
            .frame(width: height * (mark == .delivered || mark == .read ? 1.6 : 1.1), height: height)
            // One 4-pt shake per failure.
            .keyframeAnimator(initialValue: CGFloat(0), trigger: shakes) { content, offset in
                content.offset(x: offset)
            } keyframes: { _ in
                KeyframeTrack {
                    LinearKeyframe(4, duration: 0.075)
                    LinearKeyframe(-4, duration: 0.15)
                    LinearKeyframe(0, duration: 0.075)
                }
            }
            .onChange(of: mark) { _, new in
                if new == .failed {
                    CentyHaptics.warning()
                }
                guard !reduceMotion else {
                    drawn = 1
                    return
                }
                drawn = 0
                withAnimation(.easeOut(duration: 0.16)) { drawn = 1 }
                if new == .failed {
                    shakes += 1
                }
            }
            .animation(.easeOut(duration: CentyMotion.fast), value: mark)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(mark.label))
            .accessibilityIdentifier("delivery-mark")
    }

    private var color: Color {
        switch mark {
        case .failed: CentyColors.dangerText
        case .read: CentyColors.accentText
        default: CentyColors.textDim
        }
    }
}

/// The glyph paths in a unit box (stroke-drawn, so `trim` draws them in).
struct DeliveryGlyphShape: Shape {
    let mark: DeliveryMark

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * w, y: rect.minY + y * h)
        }
        switch mark {
        case .queued:
            path.addEllipse(in: rect.insetBy(dx: w * 0.05, dy: h * 0.05))
            path.move(to: p(0.5, 0.25))
            path.addLine(to: p(0.5, 0.52))
            path.addLine(to: p(0.7, 0.66))
        case .sending:
            path.move(to: p(0.5, 0.95))
            path.addLine(to: p(0.5, 0.1))
            path.move(to: p(0.18, 0.42))
            path.addLine(to: p(0.5, 0.1))
            path.addLine(to: p(0.82, 0.42))
        case .sent:
            path.move(to: p(0.08, 0.55))
            path.addLine(to: p(0.38, 0.85))
            path.addLine(to: p(0.92, 0.15))
        case .delivered, .read:
            // Two checks, the second shifted right.
            path.move(to: p(0.04, 0.55))
            path.addLine(to: p(0.24, 0.85))
            path.addLine(to: p(0.6, 0.15))
            path.move(to: p(0.42, 0.7))
            path.addLine(to: p(0.52, 0.85))
            path.addLine(to: p(0.96, 0.15))
        case .failed:
            // ⟲: an open circle with an arrowhead.
            let center = p(0.5, 0.5)
            let radius = min(w, h) * 0.42
            path.addArc(center: center, radius: radius, startAngle: .degrees(-60), endAngle: .degrees(230), clockwise: false)
            let tip = CGPoint(x: center.x + radius * cos(-60 * .pi / 180), y: center.y + radius * sin(-60 * .pi / 180))
            path.move(to: CGPoint(x: tip.x - radius * 0.55, y: tip.y - radius * 0.05))
            path.addLine(to: tip)
            path.addLine(to: CGPoint(x: tip.x + radius * 0.05, y: tip.y + radius * 0.6))
        }
        return path
    }
}

extension DeliveryMark {
    /// What VoiceOver says and the UI tests read.
    var label: LocalizedStringKey {
        switch self {
        case .queued: "Ожидает отправки"
        case .sending: "Отправляется"
        case .failed: "Не отправлено"
        case .sent: "Отправлено"
        case .delivered: "Доставлено"
        case .read: "Прочитано"
        }
    }
}

#Preview("Delivery glyphs") {
    HStack(spacing: 14) {
        ForEach([DeliveryMark.queued, .sending, .sent, .delivered, .read, .failed], id: \.self) { mark in
            DeliveryStatusView(mark: mark)
        }
    }
    .padding()
    .background(CentyColors.canvas)
}
