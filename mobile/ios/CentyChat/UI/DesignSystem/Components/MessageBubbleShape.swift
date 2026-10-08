import SwiftUI

/// The corners of a bubble in its group (desktop `.chat-message-bubble`): radius 8; on the sender's
/// side the corners where two bubbles of one group meet are 4, and only the first bubble of a group
/// has the 2-pt "tail" corner nearest the sender (top-right for own, top-left for incoming).
struct BubbleCorners: Equatable, Sendable {
    static let radius: CGFloat = 8
    static let joined: CGFloat = 4
    static let tail: CGFloat = 2

    var topLeading: CGFloat
    var bottomLeading: CGFloat
    var bottomTrailing: CGFloat
    var topTrailing: CGFloat

    static func of(isOwn: Bool, startsGroup: Bool, endsGroup: Bool) -> BubbleCorners {
        let senderTop = startsGroup ? tail : joined
        let senderBottom = endsGroup ? radius : joined
        if isOwn {
            return BubbleCorners(topLeading: radius, bottomLeading: radius, bottomTrailing: senderBottom, topTrailing: senderTop)
        }
        return BubbleCorners(topLeading: senderTop, bottomLeading: senderBottom, bottomTrailing: radius, topTrailing: radius)
    }

    var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: topLeading,
            bottomLeadingRadius: bottomLeading,
            bottomTrailingRadius: bottomTrailing,
            topTrailingRadius: topTrailing,
            style: .continuous
        )
    }
}

/// Fill and hairline of a bubble: own — `primary-soft` + `primary-line`; incoming — `card` + `border`
/// (desktop). On the L2 canvas the incoming card reads by its hairline, in light and in dark.
struct BubbleBackground: ViewModifier {
    let corners: BubbleCorners
    let isOwn: Bool

    func body(content: Content) -> some View {
        content
            .background(corners.shape.fill(isOwn ? CentyColors.ownBubble : CentyColors.card))
            .overlay(corners.shape.strokeBorder(isOwn ? CentyColors.primaryLine : CentyColors.border, lineWidth: 1))
            .clipShape(corners.shape)
    }
}
