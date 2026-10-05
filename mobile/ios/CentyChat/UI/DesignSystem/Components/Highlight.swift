import SwiftUI

/// Search highlights: the matched parts of a name or a message in the accent colour, weight 600.
/// Ranges are character offsets (`Character`), as the search reports them.
public enum Highlight {
    public struct Run: Equatable, Sendable {
        public var text: String
        public var highlighted: Bool
    }

    /// The text split into plain and highlighted runs. Overlapping ranges merge; ranges past the
    /// end are clamped.
    public static func runs(_ text: String, _ ranges: [Range<Int>]) -> [Run] {
        let characters = Array(text)
        guard !characters.isEmpty else { return [] }
        var marked = [Bool](repeating: false, count: characters.count)
        for range in ranges {
            let lower = max(0, range.lowerBound)
            let upper = min(characters.count, range.upperBound)
            guard lower < upper else { continue }
            for index in lower..<upper {
                marked[index] = true
            }
        }
        var runs: [Run] = []
        var start = 0
        for index in 1...characters.count where index == characters.count || marked[index] != marked[start] {
            runs.append(Run(text: String(characters[start..<index]), highlighted: marked[start]))
            start = index
        }
        return runs
    }

    /// The text with its highlighted runs in `color`, weight 600 (the rest keeps the caller's style).
    public static func attributed(_ text: String, _ ranges: [Range<Int>], color: Color = CentyColors.accentText) -> AttributedString {
        var result = AttributedString()
        for run in runs(text, ranges) {
            var part = AttributedString(run.text)
            if run.highlighted {
                part.foregroundColor = color
                part.inlinePresentationIntent = .stronglyEmphasized
            }
            result += part
        }
        return result
    }
}
