import SwiftUI

/// A slow 1.2 s shimmer over placeholder shapes (never a centred spinner for lists); still with
/// Reduce Motion.
struct Shimmer: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content.overlay {
                TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                    let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.2) / 1.2
                    GeometryReader { geometry in
                        LinearGradient(
                            colors: [.clear, Color.white.opacity(0.35), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: geometry.size.width * 0.6)
                        .offset(x: geometry.size.width * (CGFloat(phase) * 1.6 - 0.6))
                    }
                    .blendMode(.plusLighter)
                }
                .mask(content)
                .allowsHitTesting(false)
            }
        }
    }
}

extension View {
    func shimmering() -> some View {
        modifier(Shimmer())
    }
}

/// A placeholder bar.
struct SkeletonBar: View {
    var width: CGFloat?
    var height: CGFloat = 12

    var body: some View {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(CentyColors.sunken)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}

/// An inbox / people row while the list loads: the real row geometry (avatar, two lines), so the
/// swap to content does not shift anything.
struct SkeletonRow: View {
    var avatar: CGFloat = 44
    var nameWidth: CGFloat = 150
    var lineWidth: CGFloat = 220

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(CentyColors.sunken)
                .frame(width: avatar, height: avatar)
            VStack(alignment: .leading, spacing: 8) {
                SkeletonBar(width: nameWidth, height: 14)
                SkeletonBar(width: lineWidth, height: 12)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 64)
        .shimmering()
        .accessibilityHidden(true)
    }
}

/// A bubble while the history loads.
struct SkeletonBubble: View {
    var isOwn = false
    var width: CGFloat = 180

    var body: some View {
        HStack {
            if isOwn { Spacer(minLength: 48) }
            BubbleCorners.of(isOwn: isOwn, startsGroup: true, endsGroup: true).shape
                .fill(CentyColors.sunken)
                .frame(width: width, height: 40)
            if !isOwn { Spacer(minLength: 48) }
        }
        .shimmering()
        .accessibilityHidden(true)
    }
}

/// Several skeleton rows in a plain column (a list's first load).
struct SkeletonList: View {
    var rows = 8
    var avatar: CGFloat = 44

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<rows, id: \.self) { index in
                SkeletonRow(avatar: avatar, nameWidth: [150, 120, 170, 110][index % 4], lineWidth: [220, 180, 240, 160][index % 4])
                    .padding(.horizontal, 16)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement()
        .accessibilityLabel(Text("Загрузка"))
    }
}

#Preview("Skeletons") {
    VStack(spacing: 16) {
        SkeletonRow()
        SkeletonBubble()
        SkeletonBubble(isOwn: true, width: 140)
    }
    .padding()
    .background(CentyColors.canvas)
}
