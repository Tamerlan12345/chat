import Foundation

/// Потокобезопасный парсер и форматтер дат ISO-8601 для CentyChat
public final class DateParser: @unchecked Sendable {
    public static let shared = DateParser()
    
    private let isoFormatterWithMillis: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    
    private let isoFormatterStandard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
    
    private let fallbackFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
        return formatter
    }()
    
    private let lock = NSLock()
    
    public static func parse(_ string: String) -> Date? {
        shared.parseDate(string)
    }
    
    public static func format(_ date: Date) -> String {
        shared.formatDate(date)
    }
    
    public func parseDate(_ string: String) -> Date? {
        lock.lock()
        defer { lock.unlock() }
        
        if let date = isoFormatterWithMillis.date(from: string) {
            return date
        }
        if let date = isoFormatterStandard.date(from: string) {
            return date
        }
        return fallbackFormatter.date(from: string)
    }
    
    public func formatDate(_ date: Date) -> String {
        lock.lock()
        defer { lock.unlock() }
        return isoFormatterWithMillis.string(from: date)
    }
}
