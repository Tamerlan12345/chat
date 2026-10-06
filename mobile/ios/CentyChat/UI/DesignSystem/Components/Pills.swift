import SwiftUI

/// The unread counter of a row: `primary` pill, the number rolls when it changes, the pill scales
/// in from 0.6 (a crossfade with Reduce Motion).
struct UnreadPill: View {
    let count: Int
    var muted = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(count > 999 ? "999+" : "\(count)")
            .font(.caption.weight(.semibold).monospacedDigit())
            .foregroundStyle(CentyColors.onPrimary)
            .contentTransition(reduceMotion ? .opacity : .numericText(value: Double(count)))
            .padding(.horizontal, 6)
            .frame(minWidth: 22, minHeight: 22)
            .background(Capsule().fill(muted ? CentyColors.textDim : CentyColors.primaryBlue))
            .animation(CentyMotion.or(CentyMotion.easeOut(), reduceMotion: reduceMotion), value: count)
            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
            .accessibilityLabel(Text(RussianPlural.unread(count)))
    }
}

/// «↓ N новых»: floats above the composer when messages arrive while the reader is scrolled up.
struct JumpToLatestPill: View {
    let newCount: Int
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down")
                    .font(.footnote.weight(.bold))
                    .accessibilityHidden(true)
                if newCount > 0 {
                    Text(RussianPlural.newMessages(newCount))
                        .font(.footnote.weight(.semibold).monospacedDigit())
                        .contentTransition(reduceMotion ? .opacity : .numericText(value: Double(newCount)))
                }
            }
            .foregroundStyle(CentyColors.accentText)
            .padding(.horizontal, 14)
            .frame(minHeight: 36)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(CentyColors.border, lineWidth: 1))
            .frame(minHeight: 44)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(newCount > 0 ? Text(RussianPlural.newMessages(newCount)) : Text("К последним сообщениям"))
        .accessibilityHint(Text("Прокрутить к последнему сообщению"))
        .accessibilityIdentifier("chat-jump-latest")
    }
}

/// The date between two days of a chat: a quiet pill (`bg-sunken` over the elevated tone, `caption`
/// `textDim`, no border), sticky at the top while its day scrolls.
struct DateSeparator: View {
    let date: Date

    var body: some View {
        Text(ChatDates.dayLabel(date))
            .font(.caption.weight(.medium))
            .foregroundStyle(CentyColors.textDim)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(CentyColors.sunken))
            .background(Capsule().fill(.thinMaterial))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

extension RussianPlural {
    /// «3 непрочитанных сообщения» (VoiceOver of the pill).
    static func unread(_ count: Int) -> String {
        let noun = form(
            count,
            one: String(localized: "непрочитанное сообщение"),
            few: String(localized: "непрочитанных сообщения"),
            many: String(localized: "непрочитанных сообщений")
        )
        return "\(count) \(noun)"
    }

    /// «2 новых» on the jump pill.
    static func newMessages(_ count: Int) -> String {
        let noun = form(count, one: String(localized: "новое"), few: String(localized: "новых"), many: String(localized: "новых"))
        return "\(count) \(noun)"
    }
}

#Preview("Pills") {
    VStack(spacing: 16) {
        HStack {
            UnreadPill(count: 3)
            UnreadPill(count: 128)
        }
        JumpToLatestPill(newCount: 2) {}
        DateSeparator(date: Date())
    }
    .padding()
    .background(CentyColors.canvas)
}
