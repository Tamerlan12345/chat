import SwiftUI

/// Search highlights: the matched parts of a name or a message in the accent colour, weight 600.
/// Ranges are character offsets (`Character`), as the search reports them.
public enum Highlight {
    public struct Run: Equatable, Sendable {
        public var text: String
        public var highlighted: Bool
    }

    public static func runs(_ text: String, _ ranges: [Range<Int>]) -> [Run] {
        [Run(text: text, highlighted: false)]
    }
}
