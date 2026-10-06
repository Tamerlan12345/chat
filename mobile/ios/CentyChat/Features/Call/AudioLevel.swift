import Foundation

/// The call stage's level meter: RMS of a frame, mapped from decibels (−60…0 dB) to 0…1, and the
/// number of lit bars.
enum AudioLevel {
    static let floorDecibels: Float = -50

    static func rms(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        let sum = samples.reduce(Float(0)) { $0 + $1 * $1 }
        return (sum / Float(samples.count)).squareRoot()
    }

    /// −50 dB and below is silence (0), 0 dB is full (1), linear in decibels between.
    static func normalized(_ rms: Float) -> Float {
        guard rms > 0 else { return 0 }
        let decibels = 20 * log10(rms)
        return min(1, max(0, (decibels - floorDecibels) / -floorDecibels))
    }

    static func litBars(_ level: Float, count: Int = 5) -> Int {
        guard level > 0 else { return 0 }
        return min(count, Int((level * Float(count)).rounded(.up)))
    }
}
