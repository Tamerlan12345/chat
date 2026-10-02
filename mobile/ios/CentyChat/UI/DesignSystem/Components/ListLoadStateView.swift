import SwiftUI

/// Placeholder row for an empty list that is still loading or failed to load.
/// Returns nothing when the list loaded fine, so the caller's own empty state shows.
struct ListLoadStateView: View {
    let state: LoadState
    let failureTitle: LocalizedStringKey
    let retry: @MainActor @Sendable () async -> Void

    var body: some View {
        switch state {
        case .loading, .idle:
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 120)
                .accessibilityLabel("Загрузка")
        case .failed(let message):
            ContentUnavailableView {
                Label(failureTitle, systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Повторить") {
                    Task { await retry() }
                }
                .buttonStyle(.borderedProminent)
            }
        case .loaded:
            EmptyView()
        }
    }

    /// True when this view has something to show instead of the empty state.
    static func replacesEmptyState(_ state: LoadState) -> Bool {
        state != .loaded
    }
}
