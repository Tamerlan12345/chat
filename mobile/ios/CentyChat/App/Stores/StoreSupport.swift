import Foundation

/// Loading state of one independently fetched list.
public enum LoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)

    public var isLoading: Bool { self == .loading }

    public var errorMessage: String? {
        if case .failed(let message) = self { return message }
        return nil
    }
}

/// A store that reacts to server events delivered by `RealtimeStore`.
@MainActor
protocol RealtimeEventHandling: AnyObject {
    func handle(_ event: WSServerEvent)
}

@MainActor
final class WeakRealtimeHandler {
    weak var value: (any RealtimeEventHandling)?

    init(_ value: any RealtimeEventHandling) {
        self.value = value
    }
}

extension Error {
    /// User-facing description of an error.
    var userMessage: String {
        (self as? LocalizedError)?.errorDescription ?? localizedDescription
    }
}
