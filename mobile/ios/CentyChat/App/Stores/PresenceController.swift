import Foundation
import Observation

/// The automatic presence and the open chat of this device (`multi-device.md` §2–§4), and
/// «Не беспокоить» as the only status the user picks. Same rules as Android `PresenceController`:
/// app on screen — «В сети», in the background — «Отошёл», sent only on change and again
/// after every `auth_success`.
///
/// The chat screen reports itself through `setViewing(_:)` / `clearViewing(_:)` (`ChatStore`
/// does it for the screen it backs); the root view reports `scenePhase`.
@Observable
@MainActor
public final class PresenceController: RealtimeEventHandling {
    /// The automatic presence (the profile shows «Сейчас: …»).
    public private(set) var presence: PresenceState
    /// «Не беспокоить», as the server last confirmed it (shared by all devices).
    public private(set) var isDndEnabled = false

    @ObservationIgnored private var machine: PresenceMachine
    @ObservationIgnored private let realtime: RealtimeStore
    @ObservationIgnored private let handshake: RealtimeHandshakeState
    @ObservationIgnored private let currentUserId: @MainActor () -> Int64?
    /// Frames go out strictly in order.
    @ObservationIgnored private var sendChain: Task<Void, Never>?

    init(
        realtime: RealtimeStore,
        handshake: RealtimeHandshakeState,
        startsInBackground: Bool = false,
        currentUserId: @escaping @MainActor () -> Int64?
    ) {
        self.realtime = realtime
        self.handshake = handshake
        self.currentUserId = currentUserId
        let initial: PresenceState = startsInBackground ? .away : .online
        self.presence = initial
        self.machine = PresenceMachine(presence: initial)
        handshake.update(presence: initial, viewing: nil)
    }

    /// The chat the server considers viewed by this device right now (nil in the background).
    public var viewing: ConversationKey? { machine.viewing }

    // MARK: - Lifecycle

    /// `scenePhase == .active`.
    public func sceneDidBecomeActive() {
        apply { $0.foreground() }
    }

    /// `scenePhase == .background`. `.inactive` is transient and is not reported.
    public func sceneDidEnterBackground() {
        apply { $0.background() }
    }

    // MARK: - Viewing

    /// A chat screen is on display (the app may still be in the background).
    public func setViewing(_ conversation: ConversationKey) {
        apply { $0.setViewing(conversation) }
    }

    /// The chat screen went away; pass the chat so a late disappear does not clear a newer one.
    public func clearViewing(_ conversation: ConversationKey? = nil) {
        apply { $0.clearViewing(conversation) }
    }

    // MARK: - «Не беспокоить»

    /// Turns «Не беспокоить» on or off. Returns false (and keeps the old value) when the frame
    /// could not be sent; the server's `user_status_changed` confirms the new value.
    @discardableResult
    public func setDnd(_ enabled: Bool) async -> Bool {
        guard enabled != isDndEnabled else { return true }
        isDndEnabled = enabled
        let sent = await realtime.sendIfAuthenticated(.setDnd(enabled: enabled, customStatus: nil))
        if !sent {
            isDndEnabled = !enabled
        }
        return sent
    }

    /// The custom status travels with the current presence and does not change it; nil clears it.
    @discardableResult
    public func publishCustomStatus(_ customStatus: String?) async -> Bool {
        await realtime.sendIfAuthenticated(.presenceWithCustomStatus(state: presence, customStatus: customStatus))
    }

    func reset() {
        isDndEnabled = false
        apply { $0.clearViewing() }
    }

    // MARK: - Realtime

    func handle(_ event: WSServerEvent) {
        switch event {
        case .authSuccess(let user):
            // The server keeps «Не беспокоить» across reconnects: after login its value is right.
            isDndEnabled = user.status == .dnd
            apply { $0.authenticated() }
        case .userStatusChanged(let userId, let status, _):
            if userId == currentUserId() {
                isDndEnabled = status == .dnd
            }
        default:
            break
        }
    }

    // MARK: - Private

    private func apply(_ change: (inout PresenceMachine) -> [PresenceMachine.Frame]) {
        let frames = change(&machine)
        presence = machine.presence
        handshake.update(presence: machine.isKnown ? machine.presence : presence, viewing: machine.viewing)
        guard !frames.isEmpty else { return }
        let previous = sendChain
        let realtime = self.realtime
        sendChain = Task { [weak self] in
            await previous?.value
            for frame in frames {
                let sent = await realtime.sendIfAuthenticated(frame.message)
                if !sent {
                    self?.machine.sendFailed(frame)
                }
            }
        }
    }

    /// Waits until every frame queued so far has been handed to the socket (tests).
    func drain() async {
        await sendChain?.value
    }
}
