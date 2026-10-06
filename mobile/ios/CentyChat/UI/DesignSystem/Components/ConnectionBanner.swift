import Foundation
import Observation

/// What the connection banner says (design brief «UI layer v2», component 8).
enum LinkProblem: Equatable, Sendable {
    case offline
    case reconnecting
}

enum BannerPhase: Equatable, Sendable {
    case hidden
    case problem(LinkProblem)
    /// «Снова в сети»: after a problem, collapses by itself.
    case backOnline
}

/// The banner's state machine, as Android's `ConnectionBannerMachine`.
enum ConnectionBannerMachine {
    static let backOnlineDuration: Duration = .milliseconds(1_200)
    /// The normal connect on launch (and a blink of a reconnect) is never announced.
    static let grace: Duration = .milliseconds(1_500)

    static func problem(_ state: RealtimeConnectionState, networkAvailable: Bool?, isRunning: Bool) -> LinkProblem? {
        nil
    }

    static func onLink(_ current: BannerPhase, _ problem: LinkProblem?) -> BannerPhase {
        current
    }

    static func onBackOnlineElapsed(_ current: BannerPhase) -> BannerPhase {
        current
    }
}

/// The app-wide banner state: the realtime link and the device's network in, a phase out.
@Observable
@MainActor
final class ConnectionStatus {
    private(set) var phase: BannerPhase = .hidden

    @ObservationIgnored private let grace: Duration
    @ObservationIgnored private let backOnline: Duration

    init(grace: Duration = ConnectionBannerMachine.grace, backOnline: Duration = ConnectionBannerMachine.backOnlineDuration) {
        self.grace = grace
        self.backOnline = backOnline
    }

    func connectionChanged(_ state: RealtimeConnectionState, isRunning: Bool) {}

    func networkChanged(available: Bool) {}
}
