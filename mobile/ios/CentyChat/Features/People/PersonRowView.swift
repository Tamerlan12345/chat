import SwiftUI

/// A colleague in «Сотрудники» and in the search (64 pt): avatar 40 with the presence ring, the name
/// in `headline` with the matched part in the accent colour at weight 600 while searching,
/// «должность · отдел» on one line in `subheadline` secondary, «вн. 214» on the right in `caption`
/// dim, tabular.
struct PersonRowView: View {
    let person: Person
    var highlights: [Range<Int>] = []
    var subtitleHighlights: [Range<Int>] = []
    var extensionHighlights: [Range<Int>] = []
    /// The avatar is the zoom source of the card (iOS 18+).
    var zoom: Namespace.ID?
    /// The surface under the row (the presence ring takes its colour).
    var surface: Color = CentyColors.list

    init(person: Person, zoom: Namespace.ID? = nil, surface: Color = CentyColors.list) {
        self.person = person
        self.zoom = zoom
        self.surface = surface
    }

    init(match: PersonMatch, zoom: Namespace.ID? = nil, surface: Color = CentyColors.list) {
        person = match.person
        highlights = match.highlights
        subtitleHighlights = match.subtitleHighlights
        extensionHighlights = match.extensionHighlights
        self.zoom = zoom
        self.surface = surface
    }

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                // Accessibility sizes: the text gets the full width and wraps instead of «А…».
                VStack(alignment: .leading, spacing: 8) {
                    avatar
                    texts(lineLimit: 3)
                    extensionText
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
            } else {
                HStack(spacing: 12) {
                    avatar
                    texts(lineLimit: 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        // Hairline separators start at the text edge, not the screen edge.
                        .alignmentGuide(.listRowSeparatorLeading) { dimensions in dimensions[.leading] }
                    extensionText
                        .layoutPriority(1)
                }
                .frame(minHeight: 56)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private func texts(lineLimit: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Highlight.text(person.fullName, highlights)
                .font(.headline)
                .foregroundStyle(CentyColors.textStrong)
                .lineLimit(lineLimit)
            if !person.subtitle.isEmpty {
                Highlight.text(person.subtitle, subtitleHighlights)
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textSecondary)
                    .lineLimit(lineLimit)
            }
        }
    }

    @ViewBuilder
    private var extensionText: some View {
        if let ext = person.extension {
            Highlight.text(String(localized: "вн. \(ext)"), extensionHighlights.map { ($0.lowerBound + 4)..<($0.upperBound + 4) })
                .font(.caption.monospacedDigit())
                .foregroundStyle(CentyColors.textDim)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private var avatar: some View {
        let view = AvatarView(name: person.fullName, avatarUrl: person.avatarUrl, status: person.status, size: 40, ringColor: surface)
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

/// Placeholder rows while the directory loads for the first time (the real row geometry).
struct PersonRowSkeleton: View {
    var body: some View {
        SkeletonRow(avatar: 40, nameWidth: 160, lineWidth: 220)
    }
}

#Preview("Person rows") {
    List {
        PersonRowView(person: Person(id: 2, fullName: "Боб Тестов", jobTitle: "Инженер", departmentName: "ИТ", extension: "214", status: .online))
        PersonRowView(match: PersonMatch(person: Person(id: 3, fullName: "Карина Смирнова", jobTitle: "Бухгалтер", status: .away), rank: .namePrefix, highlights: [0..<3]))
        PersonRowSkeleton()
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(CentyColors.list)
}
