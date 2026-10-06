import Foundation
import Observation

/// A flag that is on for a while (the «Скопировано» HUD).
@Observable
@MainActor
final class TransientFlag {
    private(set) var isOn = false

    func show(for duration: Duration) {
        isOn = true
        Task { [weak self] in
            try? await Task.sleep(for: duration)
            self?.isOn = false
        }
    }
}
