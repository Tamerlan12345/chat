import SwiftUI

/// A colleague in «Сотрудники» and in the search: avatar 40 with presence, name (the matched part
/// in the accent colour while searching), «должность · отдел» on one line, «вн. 214» on the right.
struct PersonRowView: View {
    let person: Person
    var highlights: [Range<Int>] = []
    var subtitleHighlights: [Range<Int>] = []
    var extensionHighlights: [Range<Int>] = []
    /// The avatar is the zoom source of the card (iOS 18+).
    var zoom: Namespace.ID?

    init(person: Person, zoom: Namespace.ID? = nil) {
        self.person = person
        self.zoom = zoom
    }

    init(match: PersonMatch, zoom: Namespace.ID? = nil) {
        person = match.person
        highlights = match.highlights
        subtitleHighlights = match.subtitleHighlights
        extensionHighlights = match.extensionHighlights
        self.zoom = zoom
    }

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                // Accessibility sizes: the text gets the full width and wraps instead of «А…».
                VStack(alignment: .leading, spacing: 6) {
                    avatar
                    texts(lineLimit: 3)
                    extensionText
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 12) {
                    avatar
                    texts(lineLimit: 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    extensionText
                        .layoutPriority(1)
                }
                .frame(minHeight: 48)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private func texts(lineLimit: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Highlight.attributed(person.fullName, highlights))
                .font(.headline)
                .foregroundStyle(CentyColors.textStrong)
                .lineLimit(lineLimit)
            if !person.subtitle.isEmpty {
                Text(Highlight.attributed(person.subtitle, subtitleHighlights))
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textSecondary)
                    .lineLimit(lineLimit)
            }
        }
    }

    @ViewBuilder
    private var extensionText: some View {
        if let ext = person.extension {
            Text(Highlight.attributed(String(localized: "вн. \(ext)"), extensionHighlights.map { ($0.lowerBound + 4)..<($0.upperBound + 4) }))
                .font(.caption.monospacedDigit())
                .foregroundStyle(CentyColors.textDim)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private var avatar: some View {
        let view = AvatarView(name: person.fullName, avatarUrl: person.avatarUrl, status: person.status, size: 40)
        if let zoom {
            view.personZoomSource(id: person.id, namespace: zoom)
        } else {
            view
        }
    }

    private var accessibilityText: String {
        var parts = [person.fullName, person.status.displayName]
        if !person.subtitle.isEmpty { parts.append(person.subtitle) }
        if let ext = person.extension { parts.append(String(localized: "внутренний номер \(ext)")) }
        return parts.joined(separator: ", ")
    }
}

/// Placeholder rows while the directory loads for the first time.
struct PersonRowSkeleton: View {
    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(Color(uiColor: .tertiarySystemFill))
                .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color(uiColor: .tertiarySystemFill))
                    .frame(width: 160, height: 14)
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color(uiColor: .quaternarySystemFill))
                    .frame(width: 220, height: 12)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 48)
        .accessibilityHidden(true)
    }
}
