import Foundation

/// Reads an HTTP `Retry-After` header.
enum RetryAfter {
    /// Longest wait the client will honour (one day).
    static let maximum: TimeInterval = 86_400

    /// Seconds to wait, from either form the header allows: delta-seconds (`120`) or an
    /// HTTP date (`Wed, 21 Oct 2026 07:28:00 GMT`). Invalid values yield nil; the result is
    /// capped at `maximum`.
    static func seconds(from header: String?, now: Date) -> TimeInterval? {
        guard let raw = header?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else {
            return nil
        }
        if raw.allSatisfy(\.isASCII), raw.allSatisfy(\.isNumber) {
            guard let seconds = Double(raw) else { return nil }
            return min(seconds, maximum)
        }
        guard let date = httpDate(raw) else { return nil }
        return min(max(0, date.timeIntervalSince(now)).rounded(.up), maximum)
    }

    private static func httpDate(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.date(from: value)
    }
}
