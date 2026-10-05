import SwiftUI

/// The A–Я fast-scroll index on the trailing edge of an alphabetical list (as in Contacts): tap
/// or drag over a letter to jump to its section. VoiceOver: one adjustable element.
struct SectionIndexBar: View {
    let letters: [String]
    let onSelect: (String) -> Void

    @State private var current: String?

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                ForEach(letters, id: \.self) { letter in
                    Text(letter)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(CentyColors.accentText)
                        .frame(width: 20)
                        .frame(maxHeight: 16)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        select(at: value.location.y, height: geometry.size.height)
                    }
                    .onEnded { _ in current = nil }
            )
        }
        .frame(width: 24)
        .frame(maxHeight: CGFloat(letters.count) * 16)
        .accessibilityElement()
        .accessibilityLabel("Алфавитный указатель")
        .accessibilityValue(current ?? letters.first ?? "")
        .accessibilityAdjustableAction { direction in
            let index = letters.firstIndex(of: current ?? letters.first ?? "") ?? 0
            let next: Int
            switch direction {
            case .increment: next = min(letters.count - 1, index + 1)
            case .decrement: next = max(0, index - 1)
            @unknown default: return
            }
            guard letters.indices.contains(next) else { return }
            current = letters[next]
            onSelect(letters[next])
        }
    }

    private func select(at y: CGFloat, height: CGFloat) {
        guard !letters.isEmpty, height > 0 else { return }
        let index = min(letters.count - 1, max(0, Int(y / height * CGFloat(letters.count))))
        let letter = letters[index]
        guard letter != current else { return }
        current = letter
        CentyHaptics.light()
        onSelect(letter)
    }
}
