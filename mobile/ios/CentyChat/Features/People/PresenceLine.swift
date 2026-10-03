import Foundation

/// Строка статуса в карточке сотрудника: живой статус, а для не в сети — когда был(а) в сети
/// («сегодня в 14:32», «вчера в 09:10», «12 сент.»). Порт `PresenceLine` (Android).
public enum PresenceLine: Equatable, Sendable {
    case online
    case away
    case doNotDisturb
    /// Не в сети, время последнего визита неизвестно.
    case offline
    case seenToday(String)
    case seenYesterday(String)
    case seenOn(String)

    public static func of(
        status: UserStatus,
        lastSeen: Date?,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> PresenceLine {
        switch status {
        case .online: return .online
        case .away: return .away
        case .dnd: return .doNotDisturb
        case .offline: return seen(lastSeen, now: now, timeZone: timeZone)
        }
    }

    /// Текст для экрана.
    public var text: String {
        switch self {
        case .online: return String(localized: "В сети")
        case .away: return String(localized: "Отошёл(ла)")
        case .doNotDisturb: return String(localized: "Не беспокоить")
        case .offline: return String(localized: "Не в сети")
        case .seenToday(let time): return String(localized: "Был(а) в сети сегодня в \(time)")
        case .seenYesterday(let time): return String(localized: "Был(а) в сети вчера в \(time)")
        case .seenOn(let date): return String(localized: "Был(а) в сети \(date)")
        }
    }

    private static func seen(_ instant: Date?, now: Date, timeZone: TimeZone) -> PresenceLine {
        guard let instant else { return .offline }
        // Часы устройства и сервера расходятся на секунды; «будущее» дальше минуты — мусор.
        if instant > now.addingTimeInterval(60) { return .offline }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let seenDay = calendar.startOfDay(for: instant)
        let today = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: seenDay, to: today).day ?? 0
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: instant)
        let nowYear = calendar.component(.year, from: now)
        let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        let day = parts.day ?? 1
        let month = months[max(0, min(11, (parts.month ?? 1) - 1))]
        if days <= 0 { return .seenToday(time) }
        if days == 1 { return .seenYesterday(time) }
        if parts.year == nowYear { return .seenOn("\(day) \(month)") }
        return .seenOn("\(day) \(month) \(parts.year ?? nowYear)")
    }

    /// ISO-8601 из API («…T09:32:00.000Z») или время SQLite («2026-10-02 09:32:00», UTC).
    public static func parse(_ raw: String?) -> Date? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: value) { return date }
        let sqlite = DateFormatter()
        sqlite.locale = Locale(identifier: "en_US_POSIX")
        sqlite.timeZone = TimeZone(identifier: "UTC")
        sqlite.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return sqlite.date(from: value)
    }

    /// Родительный падеж с принятыми сокращениями: «12 сент.», «3 мая».
    private static let months = [
        "янв.", "февр.", "марта", "апр.", "мая", "июня",
        "июля", "авг.", "сент.", "окт.", "нояб.", "дек.",
    ]
}
