import Foundation
import Observation

/// Presence status and the wake buzzer.
@Observable
@MainActor
public final class ProfileStore: RealtimeEventHandling {
    public private(set) var wakeCooldownRemaining = 0
    public var incomingWakeAlert: String?

    @ObservationIgnored private let realtime: RealtimeStore
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private var wakeCooldownTimer: Task<Void, Never>?

    init(realtime: RealtimeStore, session: SessionStore) {
        self.realtime = realtime
        self.session = session
    }

    // MARK: - Presence

    public func updatePresence(_ status: UserStatus) async {
        session.currentUser?.status = status
        if status == .dnd {
            await realtime.send(.setDnd(enabled: true, customStatus: nil))
        } else {
            await realtime.send(.presence(state: status.rawValue, customStatus: nil))
        }
        CentyHaptics.light()
    }

    // MARK: - Wake buzzer

    public func sendWake(targetUserId: Int64) async {
        guard wakeCooldownRemaining == 0 else { return }
        await realtime.send(.wakeSend(targetUserId: targetUserId))
        startWakeCooldown(seconds: 60)
        CentyHaptics.medium()
    }

    func reset() {
        wakeCooldownTimer?.cancel()
        wakeCooldownTimer = nil
        wakeCooldownRemaining = 0
        incomingWakeAlert = nil
    }

    private func startWakeCooldown(seconds: Int) {
        wakeCooldownRemaining = seconds
        wakeCooldownTimer?.cancel()
        wakeCooldownTimer = Task { [weak self] in
            while let self, self.wakeCooldownRemaining > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                self.wakeCooldownRemaining -= 1
            }
        }
    }

    private static func secondsUntil(_ retryAtMilliseconds: Int64) -> Int {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        return max(0, Int((retryAtMilliseconds - nowMs) / 1000))
    }

    // MARK: - Realtime

    func handle(_ event: WSServerEvent) {
        switch event {
        case .wakeState(_, _, let retryAt):
            startWakeCooldown(seconds: Self.secondsUntil(retryAt))

        case .wakeRing(_, let fromName, _):
            CentyHaptics.wakeBuzzer()
            incomingWakeAlert = String(localized: "Вас вызывает: \(fromName)")

        case .wakeSent(_, _, let retryAt):
            startWakeCooldown(seconds: max(60, Self.secondsUntil(retryAt)))

        case .wakeError(let code, let message):
            session.errorMessage = message ?? String(localized: "Ошибка побудки: \(code)")

        default:
            break
        }
    }
}
