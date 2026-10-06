import Foundation

/// The call stage's level meter: RMS of a frame, mapped from decibels to 0…1, and lit bars.
enum AudioLevel {
    static func rms(_ samples: [Float]) -> Float {
        0
    }

    static func normalized(_ rms: Float) -> Float {
        0
    }

    static func litBars(_ level: Float, count: Int = 5) -> Int {
        0
    }
}
