import SwiftUI

/// The authored spot illustrations of the empty states (design brief component 10): vector line art
/// in `primary` and graphite with soft `primary-soft` fills, no gradients, no stock art.
enum SpotIllustration: String, CaseIterable, Sendable {
    /// Inbox: two overlapping bubbles.
    case bubbles
    /// Channels: a hash in a bubble.
    case channel
    /// Announcements: a megaphone with a check.
    case megaphone
    /// Offline / failed to load: a cloud with a broken link.
    case offline
    /// Search: a magnifier over an empty bubble.
    case search
    /// People: two heads.
    case people
}

/// One illustration, drawn in a 120-pt box (scaled with the text up to a cap).
struct SpotIllustrationView: View {
    let kind: SpotIllustration
    @ScaledMetric(relativeTo: .title) private var side: CGFloat = 120

    var body: some View {
        Canvas { context, size in
            let unit = min(size.width, size.height) / 120
            func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
                CGRect(x: x * unit, y: y * unit, width: w * unit, height: h * unit)
            }
            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: x * unit, y: y * unit)
            }
            let line = StrokeStyle(lineWidth: 3 * unit, lineCap: .round, lineJoin: .round)
            let accent = GraphicsContext.Shading.color(CentyColors.primaryBlue)
            let graphite = GraphicsContext.Shading.color(CentyColors.textSecondary)
            let soft = GraphicsContext.Shading.color(CentyColors.primarySoft)
            let paper = GraphicsContext.Shading.color(CentyColors.card)

            func bubble(_ frame: CGRect, tailLeft: Bool) -> Path {
                var path = Path(roundedRect: frame, cornerRadius: 12 * unit, style: .continuous)
                let baseX = tailLeft ? frame.minX + 14 * unit : frame.maxX - 14 * unit
                var tail = Path()
                tail.move(to: CGPoint(x: baseX - 6 * unit, y: frame.maxY - 1))
                tail.addLine(to: CGPoint(x: baseX + (tailLeft ? -10 : 10) * unit, y: frame.maxY + 10 * unit))
                tail.addLine(to: CGPoint(x: baseX + 6 * unit, y: frame.maxY - 1))
                path.addPath(tail)
                return path
            }

            switch kind {
            case .bubbles:
                let back = bubble(rect(14, 22, 62, 42), tailLeft: true)
                context.fill(back, with: soft)
                context.stroke(back, with: graphite, style: line)
                let front = bubble(rect(44, 50, 62, 40), tailLeft: false)
                context.fill(front, with: paper)
                context.fill(front, with: soft)
                context.stroke(front, with: accent, style: line)
                for (index, width) in [CGFloat(34), CGFloat(22)].enumerated() {
                    var bar = Path()
                    bar.move(to: point(56, 64 + CGFloat(index) * 12))
                    bar.addLine(to: point(56 + width, 64 + CGFloat(index) * 12))
                    context.stroke(bar, with: accent, style: line)
                }
            case .channel:
                let frame = bubble(rect(22, 24, 76, 58), tailLeft: true)
                context.fill(frame, with: soft)
                context.stroke(frame, with: graphite, style: line)
                var hash = Path()
                hash.move(to: point(52, 38)); hash.addLine(to: point(48, 70))
                hash.move(to: point(68, 38)); hash.addLine(to: point(64, 70))
                hash.move(to: point(42, 48)); hash.addLine(to: point(78, 48))
                hash.move(to: point(40, 60)); hash.addLine(to: point(76, 60))
                context.stroke(hash, with: accent, style: line)
            case .megaphone:
                var horn = Path()
                horn.move(to: point(24, 50))
                horn.addLine(to: point(70, 30))
                horn.addLine(to: point(70, 82))
                horn.addLine(to: point(24, 64))
                horn.closeSubpath()
                context.fill(horn, with: soft)
                context.stroke(horn, with: graphite, style: line)
                var handle = Path()
                handle.move(to: point(34, 66)); handle.addLine(to: point(40, 86))
                context.stroke(handle, with: graphite, style: line)
                let badge = Path(ellipseIn: rect(72, 56, 34, 34))
                context.fill(badge, with: paper)
                context.fill(badge, with: soft)
                context.stroke(badge, with: accent, style: line)
                var check = Path()
                check.move(to: point(81, 73)); check.addLine(to: point(87, 79)); check.addLine(to: point(97, 67))
                context.stroke(check, with: accent, style: line)
            case .offline:
                // One outline: the lobes merged, no inner lines.
                let cloud = Path(ellipseIn: rect(22, 46, 36, 30))
                    .union(Path(ellipseIn: rect(40, 30, 44, 42)))
                    .union(Path(ellipseIn: rect(66, 46, 34, 30)))
                    .union(Path(roundedRect: rect(36, 56, 50, 20), cornerRadius: 6 * unit))
                context.fill(cloud, with: soft)
                context.stroke(cloud, with: graphite, style: line)
                var link = Path()
                link.addRoundedRect(in: rect(34, 88, 20, 12), cornerSize: CGSize(width: 6 * unit, height: 6 * unit))
                link.addRoundedRect(in: rect(66, 88, 20, 12), cornerSize: CGSize(width: 6 * unit, height: 6 * unit))
                context.stroke(link, with: accent, style: line)
                var gap = Path()
                gap.move(to: point(58, 86)); gap.addLine(to: point(62, 102))
                context.stroke(gap, with: accent, style: StrokeStyle(lineWidth: 2 * unit, lineCap: .round, dash: [2 * unit, 4 * unit]))
            case .search:
                let frame = bubble(rect(18, 22, 70, 50), tailLeft: true)
                context.fill(frame, with: soft)
                context.stroke(frame, with: graphite, style: StrokeStyle(lineWidth: 3 * unit, lineCap: .round, dash: [6 * unit, 6 * unit]))
                let lens = Path(ellipseIn: rect(52, 50, 38, 38))
                context.fill(lens, with: paper)
                context.stroke(lens, with: accent, style: line)
                var handle = Path()
                handle.move(to: point(84, 82)); handle.addLine(to: point(100, 98))
                context.stroke(handle, with: accent, style: StrokeStyle(lineWidth: 5 * unit, lineCap: .round))
            case .people:
                let back = Path(ellipseIn: rect(62, 28, 30, 30))
                context.fill(back, with: soft)
                context.stroke(back, with: graphite, style: line)
                var backBody = Path()
                backBody.addArc(center: point(77, 92), radius: 24 * unit, startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)
                context.stroke(backBody, with: graphite, style: line)
                let front = Path(ellipseIn: rect(30, 36, 34, 34))
                context.fill(front, with: paper)
                context.fill(front, with: soft)
                context.stroke(front, with: accent, style: line)
                var frontBody = Path()
                frontBody.addArc(center: point(47, 104), radius: 28 * unit, startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)
                context.stroke(frontBody, with: accent, style: line)
            }
        }
        .frame(width: min(side, 160), height: min(side, 160))
        .accessibilityHidden(true)
    }
}

/// An empty, failed or offline state: the illustration, one sentence, one action that names the
/// next step (a tonal button), placed at about 35 % of the height rather than dead centre.
struct EmptyStateView<Actions: View>: View {
    let illustration: SpotIllustration
    let title: LocalizedStringKey
    var message: LocalizedStringKey?
    @ViewBuilder var actions: () -> Actions

    init(
        illustration: SpotIllustration,
        title: LocalizedStringKey,
        message: LocalizedStringKey? = nil,
        @ViewBuilder actions: @escaping () -> Actions
    ) {
        self.illustration = illustration
        self.title = title
        self.message = message
        self.actions = actions
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                        .frame(height: max(16, geometry.size.height * 0.35 - 120))
                    VStack(spacing: 12) {
                        SpotIllustrationView(kind: illustration)
                            .padding(.bottom, 4)
                        Text(title)
                            .font(.headline)
                            .foregroundStyle(CentyColors.textStrong)
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.isHeader)
                        if let message {
                            Text(message)
                                .font(.subheadline)
                                .foregroundStyle(CentyColors.textSecondary)
                                .multilineTextAlignment(.center)
                        }
                        actions()
                            .padding(.top, 12)
                    }
                    .frame(maxWidth: 360)
                    .padding(.horizontal, 32)
                    .frame(maxWidth: .infinity)
                    Spacer(minLength: 24)
                }
                .frame(minHeight: geometry.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

extension EmptyStateView where Actions == EmptyView {
    init(illustration: SpotIllustration, title: LocalizedStringKey, message: LocalizedStringKey? = nil) {
        self.init(illustration: illustration, title: title, message: message) { EmptyView() }
    }
}

/// A tonal button sized to its label (the action of an empty state).
struct EmptyStateAction: View {
    let title: LocalizedStringKey
    var systemImage: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .accessibilityHidden(true)
                }
                Text(title)
            }
        }
        .buttonStyle(CentyButtonStyle(kind: .tonal))
        .fixedSize(horizontal: true, vertical: false)
        .frame(maxWidth: .infinity)
    }
}

#Preview("Spot illustrations") {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 130))], spacing: 16) {
        ForEach(SpotIllustration.allCases, id: \.self) { kind in
            SpotIllustrationView(kind: kind)
        }
    }
    .padding()
    .background(CentyColors.list)
}

#Preview("Empty state") {
    EmptyStateView(illustration: .bubbles, title: "Пока нет диалогов", message: "Напишите коллеге — переписка появится здесь.") {
        EmptyStateAction(title: "Найти сотрудника", systemImage: "person.2") {}
    }
    .background(CentyColors.list)
}
