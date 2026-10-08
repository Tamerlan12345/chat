import SwiftUI

/// Three dots in a wave with a 0.2 s stagger (desktop `typing-dots`). Runs only while on screen;
/// with Reduce Motion the dots stay still.
struct TypingDots: View {
    var color: Color = CentyColors.textDim
    var size: CGFloat = 5

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            dots(phase: nil)
        } else {
            TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                dots(phase: context.date.timeIntervalSinceReferenceDate)
            }
        }
    }

    private func dots(phase: TimeInterval?) -> some View {
        HStack(spacing: size * 0.6) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(color)
                    .frame(width: size, height: size)
                    .opacity(opacity(index, phase))
                    .offset(y: offset(index, phase))
            }
        }
        .frame(height: size * 2.2)
    }

    /// A 1.2 s cycle; each dot 0.2 s after the previous one.
    private func wave(_ index: Int, _ phase: TimeInterval) -> Double {
        let cycle = 1.2
        let t = (phase - Double(index) * 0.2).truncatingRemainder(dividingBy: cycle) / cycle
        let local = t < 0 ? t + 1 : t
        return local < 0.4 ? sin(local / 0.4 * .pi) : 0
    }

    private func opacity(_ index: Int, _ phase: TimeInterval?) -> Double {
        guard let phase else { return 0.7 }
        return 0.35 + 0.65 * wave(index, phase)
    }

    private func offset(_ index: Int, _ phase: TimeInterval?) -> CGFloat {
        guard let phase else { return 0 }
        return -CGFloat(wave(index, phase)) * size * 0.5
    }
}

/// «печатает…» under a chat title, in an inbox row or as a bubble at the end of a chat: the dots
/// wave plus the text in the accent colour.
public struct TypingIndicatorView: View {
    public let text: String

    public init(text: String = String(localized: "печатает...")) {
        self.text = text
    }

    public var body: some View {
        HStack(spacing: 6) {
            TypingDots(color: CentyColors.accentText, size: 4)
            Text(text)
                .font(.footnote)
                .foregroundStyle(CentyColors.accentText)
                .lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(text))
    }
}

/// The typing indicator as an incoming bubble at the end of the chat.
struct TypingBubble: View {
    var body: some View {
        TypingDots(color: CentyColors.textDim, size: 6)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .modifier(BubbleBackground(corners: .of(isOwn: false, startsGroup: true, endsGroup: true), isOwn: false))
            .accessibilityLabel(Text("Собеседник печатает"))
    }
}

#Preview("Typing") {
    VStack(alignment: .leading, spacing: 16) {
        TypingIndicatorView(text: "Боб печатает...")
        TypingBubble()
    }
    .padding()
    .background(CentyColors.canvas)
}
