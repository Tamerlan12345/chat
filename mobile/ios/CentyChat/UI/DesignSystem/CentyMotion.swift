import SwiftUI

/// The motion grammar of the design brief: desktop durations (fast 120 / base 180 / slow 280 ms),
/// the decelerate curve, and the Reduce Motion fallback (a short crossfade or nothing).
enum CentyMotion {
    static let fast: TimeInterval = 0.12
    static let base: TimeInterval = 0.18
    static let slow: TimeInterval = 0.28
    /// Reduce Motion: every effect becomes this crossfade.
    static let crossfade: TimeInterval = 0.15

    /// `cubic-bezier(.22, 1, .36, 1)` — the desktop's ease-out.
    static func easeOut(_ duration: TimeInterval = base) -> Animation {
        .timingCurve(0.22, 1, 0.36, 1, duration: duration)
    }

    /// `cubic-bezier(.16, 1, .3, 1)` — the "message lands" lift.
    static func decelerate(_ duration: TimeInterval = 0.24) -> Animation {
        .timingCurve(0.16, 1, 0.3, 1, duration: duration)
    }

    /// The lift of a new own bubble: a spring with damping 0.85, a fade with Reduce Motion.
    static func lift(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeOut(duration: crossfade) : .spring(response: 0.24, dampingFraction: 0.85)
    }

    /// `animation` normally, the short crossfade with Reduce Motion.
    static func or(_ animation: Animation, reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeOut(duration: crossfade) : animation
    }
}

/// Staggered appearance of list items (search sections, «Отделы» children). None with Reduce Motion.
enum Stagger {
    /// «Отделы»: children of an expanding department, 20 ms apart, at most 6 steps.
    static func departmentRow(index: Int, reduceMotion: Bool) -> TimeInterval {
        delay(index: index, step: 0.02, steps: 6, reduceMotion: reduceMotion)
    }

    /// Search: the items of a section, 30 ms apart, at most 3 steps.
    static func searchItem(index: Int, reduceMotion: Bool) -> TimeInterval {
        delay(index: index, step: 0.03, steps: 3, reduceMotion: reduceMotion)
    }

    private static func delay(index: Int, step: TimeInterval, steps: Int, reduceMotion: Bool) -> TimeInterval {
        guard !reduceMotion, index > 0 else { return 0 }
        return step * TimeInterval(min(index, steps - 1))
    }
}

extension View {
    /// Fades the view in `delay` seconds after it appears (the stagger); instant with Reduce Motion.
    func staggeredAppearance(delay: TimeInterval, reduceMotion: Bool) -> some View {
        modifier(StaggeredAppearance(delay: delay, reduceMotion: reduceMotion))
    }
}

private struct StaggeredAppearance: ViewModifier {
    let delay: TimeInterval
    let reduceMotion: Bool
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown || reduceMotion ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 4)
            .onAppear {
                guard !shown, !reduceMotion else { return }
                withAnimation(CentyMotion.easeOut(CentyMotion.base).delay(delay)) {
                    shown = true
                }
            }
    }
}
