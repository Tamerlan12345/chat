import Foundation
import Observation
import SwiftUI

/// A flag that is on for a while (the «Скопировано» HUD). Showing it again restarts the time: the
/// previous timer is cancelled, so a second copy never disappears early.
@Observable
@MainActor
final class TransientFlag {
    private(set) var isOn = false
    @ObservationIgnored private var timer: Task<Void, Never>?

    func show(for duration: Duration) {
        isOn = true
        timer?.cancel()
        timer = Task { [weak self] in
            do {
                try await Task.sleep(for: duration)
            } catch {
                return
            }
            self?.isOn = false
        }
    }

    func hide() {
        timer?.cancel()
        timer = nil
        isOn = false
    }
}

/// A small HUD capsule at the bottom of the screen (L3 material), e.g. «Скопировано».
struct HUDCapsule: View {
    let text: LocalizedStringKey
    var systemImage: String = "checkmark.circle.fill"

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(CentyColors.textStrong)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(CentyColors.border, lineWidth: 1))
            .accessibilityElement(children: .combine)
    }
}

#Preview("HUD") {
    HUDCapsule(text: "Скопировано")
        .padding()
        .background(CentyColors.list)
}
