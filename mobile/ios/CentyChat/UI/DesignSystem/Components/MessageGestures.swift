import SwiftUI

/// Swipe-to-reply (design brief component 11): dragging a bubble to the left reveals an arrow that
/// fills toward the threshold; crossing it gives a light haptic tick, releasing past it starts a
/// reply. VoiceOver gets the same as a named action; with Reduce Motion the bubble snaps back.
struct SwipeToReply: ViewModifier {
    let isEnabled: Bool
    let onReply: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var offset: CGFloat = 0
    @State private var armed = false

    private static let threshold: CGFloat = 64

    private var progress: CGFloat {
        min(1, -offset / Self.threshold)
    }

    func body(content: Content) -> some View {
        content
            .offset(x: offset)
            .overlay(alignment: .trailing) {
                if offset < 0 {
                    ZStack {
                        Circle()
                            .fill(CentyColors.primarySoft)
                        Circle()
                            .trim(from: 0, to: progress)
                            .stroke(CentyColors.accentText, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                        Image(systemName: "arrowshape.turn.up.left.fill")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(CentyColors.accentText)
                    }
                    .frame(width: 30, height: 30)
                    .scaleEffect(0.6 + 0.4 * progress)
                    .opacity(Double(progress))
                    .offset(x: 36 + offset * 0.4)
                    .accessibilityHidden(true)
                }
            }
            .simultaneousGesture(isEnabled ? drag : nil)
            .accessibilityAction(named: Text("Ответить")) {
                if isEnabled { onReply() }
            }
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 24, coordinateSpace: .local)
            .onChanged { value in
                let horizontal = value.translation.width
                // Only a clear leftward drag: vertical scrolling stays the list's.
                guard horizontal < 0, abs(horizontal) > abs(value.translation.height) * 1.6 else { return }
                offset = max(horizontal, -Self.threshold * 1.4)
                let crossed = -offset >= Self.threshold
                if crossed != armed {
                    armed = crossed
                    if crossed { CentyHaptics.light() }
                }
            }
            .onEnded { _ in
                if armed { onReply() }
                armed = false
                withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.8)) {
                    offset = 0
                }
            }
    }
}

extension View {
    func swipeToReply(isEnabled: Bool, onReply: @escaping () -> Void) -> some View {
        modifier(SwipeToReply(isEnabled: isEnabled, onReply: onReply))
    }
}

/// A check mark that draws itself in (the «Ознакомлен» stamp).
struct CheckDrawShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + rect.width * 0.12, y: rect.minY + rect.height * 0.55))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.4, y: rect.minY + rect.height * 0.82))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.9, y: rect.minY + rect.height * 0.2))
        return path
    }
}

/// «Подтверждаю ознакомление» → the check draws in, the button turns into the success state, a
/// success haptic (design brief component 13). Reduce Motion: the check appears at once.
struct AcknowledgeButton: View {
    let isConfirmed: Bool
    var confirmedAt: Date?
    let isBusy: Bool
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawn: CGFloat = 1
    @ScaledMetric(relativeTo: .headline) private var checkSide: CGFloat = 18

    var body: some View {
        Group {
            if isConfirmed {
                HStack(spacing: 10) {
                    CheckDrawShape()
                        .trim(from: 0, to: drawn)
                        .stroke(CentyColors.successText, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                        .frame(width: checkSide, height: checkSide)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Ознакомлен")
                            .font(.headline)
                        if let confirmedAt {
                            Text(confirmedAt, format: .dateTime.day().month(.wide).hour().minute())
                                .font(.footnote)
                                .environment(\.locale, Locale(identifier: "ru_RU"))
                        }
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(CentyColors.successText)
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(CentyColors.successSoft))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("announcement-acknowledged")
                .transition(.opacity)
            } else {
                CentyButton(title: "Подтверждаю ознакомление", icon: "signature", isLoading: isBusy, action: action)
                    .accessibilityIdentifier("announcement-acknowledge")
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: CentyMotion.base), value: isConfirmed)
        .onChange(of: isConfirmed) { _, confirmed in
            guard confirmed else { return }
            guard !reduceMotion else {
                drawn = 1
                return
            }
            drawn = 0
            withAnimation(CentyMotion.easeOut(CentyMotion.slow).delay(0.1)) { drawn = 1 }
        }
    }
}

#Preview("Acknowledge") {
    VStack(spacing: 16) {
        AcknowledgeButton(isConfirmed: false, isBusy: false) {}
        AcknowledgeButton(isConfirmed: true, confirmedAt: Date(), isBusy: false) {}
    }
    .padding()
    .background(CentyColors.canvas)
}
