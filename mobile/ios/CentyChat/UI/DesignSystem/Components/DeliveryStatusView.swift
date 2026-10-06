import SwiftUI

/// The state of an own message (`delivery-state.md` §3.4): queued (clock), sending (arrow), failed
/// (exclamation), sent (one check), delivered (two checks), read (two bright checks). On the brand
/// bubble, so it is drawn in white tones; failed stands out in a badge.
struct DeliveryStatusView: View {
    let mark: DeliveryMark

    init(mark: DeliveryMark) {
        self.mark = mark
    }

    var body: some View {
        Group {
            switch mark {
            case .queued:
                Image(systemName: "clock")
                    .foregroundStyle(.white.opacity(0.8))
            case .sending:
                Image(systemName: "arrow.up.circle")
                    .foregroundStyle(.white.opacity(0.8))
            case .failed:
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(.white)
            case .sent:
                Image(systemName: "checkmark")
                    .fontWeight(.bold)
                    .foregroundStyle(.white.opacity(0.85))
            case .delivered, .read:
                HStack(spacing: -4) {
                    Image(systemName: "checkmark")
                    Image(systemName: "checkmark")
                }
                .fontWeight(.bold)
                .foregroundStyle(mark == .read ? .white : .white.opacity(0.7))
            }
        }
        .font(.system(size: 10))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(mark.label))
        .accessibilityIdentifier("delivery-mark")
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
