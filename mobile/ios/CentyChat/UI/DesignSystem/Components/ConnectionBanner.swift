import Foundation
import Observation
import SwiftUI

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

/// The banner's state machine, as Android's `ConnectionBannerMachine`: a problem shows (and may
/// change its kind); the link coming back after a problem says «Снова в сети» for 1.2 s; a link
/// that was never down says nothing.
enum ConnectionBannerMachine {
    static let backOnlineDuration: Duration = .milliseconds(1_200)
    /// The normal connect on launch (and a blink of a reconnect) is never announced.
    static let grace: Duration = .milliseconds(1_500)

    /// nil while the link is fine or the session is not listening at all (signed out).
    static func problem(_ state: RealtimeConnectionState, networkAvailable: Bool?, isRunning: Bool) -> LinkProblem? {
        guard isRunning else { return nil }
        if state == .connected { return nil }
        if networkAvailable == false { return .offline }
        return .reconnecting
    }

    static func onLink(_ current: BannerPhase, _ problem: LinkProblem?) -> BannerPhase {
        if let problem { return .problem(problem) }
        if case .problem = current { return .backOnline }
        return current
    }

    static func onBackOnlineElapsed(_ current: BannerPhase) -> BannerPhase {
        current == .backOnline ? .hidden : current
    }
}

/// The app-wide banner state: the realtime link and the device's network in, a phase out. A problem
/// waits out the grace period before it shows; once shown, it changes at once.
@Observable
@MainActor
final class ConnectionStatus {
    private(set) var phase: BannerPhase = .hidden

    @ObservationIgnored private let grace: Duration
    @ObservationIgnored private let backOnline: Duration
    @ObservationIgnored private var connection: RealtimeConnectionState = .disconnected
    @ObservationIgnored private var isRunning = false
    @ObservationIgnored private var networkAvailable: Bool?
    @ObservationIgnored private var problem: LinkProblem?
    @ObservationIgnored private var timer: Task<Void, Never>?

    init(grace: Duration = ConnectionBannerMachine.grace, backOnline: Duration = ConnectionBannerMachine.backOnlineDuration) {
        self.grace = grace
        self.backOnline = backOnline
    }

    func connectionChanged(_ state: RealtimeConnectionState, isRunning: Bool) {
        connection = state
        self.isRunning = isRunning
        evaluate()
    }

    func networkChanged(available: Bool) {
        networkAvailable = available
        evaluate()
    }

    private func evaluate() {
        let next = ConnectionBannerMachine.problem(connection, networkAvailable: networkAvailable, isRunning: isRunning)
        guard next != problem else { return }
        problem = next
        timer?.cancel()
        timer = nil
        if next != nil, phase == .hidden || phase == .backOnline, grace > .zero {
            let wait = grace
            timer = Task { [weak self] in
                do {
                    try await Task.sleep(for: wait)
                } catch {
                    return
                }
                self?.apply()
            }
        } else {
            apply()
        }
    }

    private func apply() {
        phase = ConnectionBannerMachine.onLink(phase, problem)
        guard phase == .backOnline else { return }
        let wait = backOnline
        timer = Task { [weak self] in
            do {
                try await Task.sleep(for: wait)
            } catch {
                return
            }
            guard let self else { return }
            self.phase = ConnectionBannerMachine.onBackOnlineElapsed(self.phase)
        }
    }
}

/// Compact banner under the navigation bar, only while the link is down: «Нет сети» (danger-soft),
/// «Переподключение…» (warning-soft, dots), then «Снова в сети» (success-soft, collapses after
/// 1.2 s). An L3 surface: the soft tint over the elevated tone and a hairline. Slides down; with
/// Reduce Motion it crossfades.
struct ConnectionBanner: View {
    let phase: BannerPhase

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if phase != .hidden {
                content
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity)
        .clipped()
        .animation(CentyMotion.or(CentyMotion.easeOut(CentyMotion.slow), reduceMotion: reduceMotion), value: phase)
    }

    private var content: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.footnote.weight(.semibold))
                .accessibilityHidden(true)
            Text(title)
                .font(.footnote.weight(.semibold))
            if phase == .problem(.reconnecting) {
                TypingDots(color: tint)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(minHeight: 36)
        .background(fill)
        .background(CentyColors.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(CentyColors.border).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityIdentifier("connection-banner")
    }

    private var title: LocalizedStringKey {
        switch phase {
        case .problem(.offline): "Нет сети"
        case .problem(.reconnecting): "Переподключение…"
        case .backOnline, .hidden: "Снова в сети"
        }
    }

    private var icon: String {
        switch phase {
        case .problem(.offline): "wifi.slash"
        case .problem(.reconnecting): "arrow.triangle.2.circlepath"
        case .backOnline, .hidden: "checkmark.circle.fill"
        }
    }

    private var tint: Color {
        switch phase {
        case .problem(.offline): CentyColors.dangerText
        case .problem(.reconnecting): CentyColors.warningText
        case .backOnline, .hidden: CentyColors.successText
        }
    }

    /// The soft tint drawn over the elevated tone.
    private var fill: some View {
        Group {
            switch phase {
            case .problem(.offline): CentyColors.dangerSoft
            case .problem(.reconnecting): CentyColors.warningSoft
            case .backOnline, .hidden: CentyColors.successSoft
            }
        }
    }
}

extension View {
    /// The app's connection banner pinned under the navigation bar of this screen.
    func connectionBanner() -> some View {
        modifier(ConnectionBannerInset())
    }
}

private struct ConnectionBannerInset: ViewModifier {
    @Environment(ConnectionStatus.self) private var status: ConnectionStatus?

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .top, spacing: 0) {
            ConnectionBanner(phase: status?.phase ?? .hidden)
        }
    }
}

#Preview("ConnectionBanner") {
    VStack(spacing: 12) {
        ConnectionBanner(phase: .problem(.offline))
        ConnectionBanner(phase: .problem(.reconnecting))
        ConnectionBanner(phase: .backOnline)
    }
    .background(CentyColors.list)
}
