import SwiftUI

/// The white "c" of the CentyChat mark.
///
/// Exact port of `BRAND_C_PATH` from the desktop `BrandMark.jsx` (880×880 viewBox):
/// `M619.8 190H469.8A140 140 0 0 0 329.8 330V550A140 140 0 0 0 469.8 690H619.8V621H469.8`
/// `A71 71 0 0 1 398.8 550V330A71 71 0 0 1 469.8 259H619.8Z`.
/// Every SVG arc there is a quarter circle at a corner, so each is drawn as the tangent arc
/// between the same two lines with the same radius, which is the identical curve.
struct BrandCShape: Shape {
    static let viewBox: CGFloat = 880

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / Self.viewBox
        let originX = rect.minX + (rect.width - Self.viewBox * scale) / 2
        let originY = rect.minY + (rect.height - Self.viewBox * scale) / 2
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: originX + x * scale, y: originY + y * scale)
        }

        var path = Path()
        path.move(to: point(619.8, 190))
        path.addLine(to: point(469.8, 190))
        path.addArc(tangent1End: point(329.8, 190), tangent2End: point(329.8, 330), radius: 140 * scale)
        path.addLine(to: point(329.8, 550))
        path.addArc(tangent1End: point(329.8, 690), tangent2End: point(469.8, 690), radius: 140 * scale)
        path.addLine(to: point(619.8, 690))
        path.addLine(to: point(619.8, 621))
        path.addLine(to: point(469.8, 621))
        path.addArc(tangent1End: point(398.8, 621), tangent2End: point(398.8, 550), radius: 71 * scale)
        path.addLine(to: point(398.8, 330))
        path.addArc(tangent1End: point(398.8, 259), tangent2End: point(469.8, 259), radius: 71 * scale)
        path.addLine(to: point(619.8, 259))
        path.closeSubpath()
        return path
    }
}

/// The CentyChat mark: rounded square (rx 205/880) in the brand gradient, a subtle light rim
/// and the white "c". Decorative; the wordmark next to it carries the accessible name.
public struct BrandMark: View {
    public var size: CGFloat

    public init(size: CGFloat) {
        self.size = size
    }

    public var body: some View {
        let unit = size / BrandCShape.viewBox
        ZStack {
            RoundedRectangle(cornerRadius: 205 * unit, style: .circular)
                .fill(CentyColors.brandGradient)
            RoundedRectangle(cornerRadius: 205 * unit, style: .circular)
                .strokeBorder(CentyColors.brandRim, lineWidth: 12 * unit)
            BrandCShape()
                .fill(CentyColors.brandGlyph)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// «CentyChat» set like the desktop lockup: "Centy" bold, "Chat" regular, strong text colour.
public struct BrandWordmark: View {
    public init() {}

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(verbatim: "Centy").fontWeight(.bold)
            Text(verbatim: "Chat").fontWeight(.regular)
        }
        .font(.largeTitle)
        .foregroundStyle(CentyColors.textStrong)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "CentyChat"))
        .accessibilityAddTraits(.isHeader)
    }
}
