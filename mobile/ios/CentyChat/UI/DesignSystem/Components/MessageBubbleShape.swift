import SwiftUI

/// The corners of a bubble in its group.
struct BubbleCorners: Equatable, Sendable {
    var topLeading: CGFloat
    var bottomLeading: CGFloat
    var bottomTrailing: CGFloat
    var topTrailing: CGFloat

    static func of(isOwn: Bool, startsGroup: Bool, endsGroup: Bool) -> BubbleCorners {
        BubbleCorners(topLeading: 16, bottomLeading: 16, bottomTrailing: 16, topTrailing: 16)
    }
}
