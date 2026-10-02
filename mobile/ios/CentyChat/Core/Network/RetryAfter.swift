import Foundation

/// Reads an HTTP `Retry-After` header.
enum RetryAfter {
    /// Longest wait the client will honour (one day).
    static let maximum: TimeInterval = 86_400

    static func seconds(from header: String?, now: Date) -> TimeInterval? {
        nil
    }
}
