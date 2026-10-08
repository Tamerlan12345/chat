import Foundation
import Observation

/// «Не беспокоить» and the wake buzzer. Presence itself is automatic (`PresenceController`).
@Observable
@MainActor
public final class ProfileStore: RealtimeEventHandling {
    public private(set) var wakeCooldownRemaining = 0
    public var incomingWakeAlert: String?

    @ObservationIgnored private let realtime: RealtimeStore
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private let presence: PresenceController
    @ObservationIgnored private var wakeCooldownTimer: Task<Void, Never>?

    init(realtime: RealtimeStore, session: SessionStore, presence: PresenceController) {
        self.realtime = realtime
        self.session = session
        self.presence = presence
    }

    // MARK: - Presence

    /// «Не беспокоить» — the only status the user picks (owner's rule). «В сети» / «Отошёл»
    /// follow the app being on screen. Returns false and keeps the old value when it was not sent.
    public var isDndEnabled: Bool { presence.isDndEnabled }

    /// The automatic presence for «Сейчас: …».
    public var automaticPresence: PresenceState { presence.presence }

    @discardableResult
    public func setDnd(_ enabled: Bool) async -> Bool {
        let sent = await presence.setDnd(enabled)
        if sent {
            CentyHaptics.light()
        } else {
            session.errorMessage = String(localized: "Не удалось изменить статус. Проверьте подключение.")
        }
        return sent
    }

    /// Old three-status picker: only «Не беспокоить» is a choice now; any other value turns it off.
    @available(*, deprecated, message: "Use setDnd(_:); presence is automatic")
    public func updatePresence(_ status: UserStatus) async {
        await setDnd(status == .dnd)
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
