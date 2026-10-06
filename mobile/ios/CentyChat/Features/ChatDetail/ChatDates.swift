import Foundation

/// Dates of the chat in Russian whatever the device region, with format styles built once
/// (`Date.FormatStyle` keeps its formatter): the day separators («Сегодня», «Вчера», «15 сентября»,
/// «31 августа 2025 г.») and the inbox times («16:00», «Вчера», «пт», «31.08.25»).
enum ChatDates {
    private static let russian = Locale(identifier: "ru_RU")

    private static let time = Date.FormatStyle(locale: russian).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
    private static let dayMonth = Date.FormatStyle(locale: russian).day().month(.wide)
    private static let dayMonthYear = Date.FormatStyle(locale: russian).day().month(.wide).year()
    private static let weekday = Date.FormatStyle(locale: russian).weekday(.abbreviated)
    private static let numeric = Date.FormatStyle(locale: russian).day(.twoDigits).month(.twoDigits).year(.twoDigits)

    private static func styled(_ style: Date.FormatStyle, _ calendar: Calendar) -> Date.FormatStyle {
        var style = style
        style.calendar = calendar
        style.timeZone = calendar.timeZone
        return style
    }

    /// The pill between two days of a chat.
    static func dayLabel(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return String(localized: "Сегодня") }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return String(localized: "Вчера")
        }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        return date.formatted(styled(sameYear ? dayMonth : dayMonthYear, calendar))
    }

    /// The time on the right of an inbox row.
    static func inboxTime(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(styled(time, calendar)) }
        let today = calendar.startOfDay(for: now)
        let day = calendar.startOfDay(for: date)
        let days = calendar.dateComponents([.day], from: day, to: today).day ?? Int.max
        if days == 1 { return String(localized: "Вчера") }
        if days > 1 && days < 7 { return date.formatted(styled(weekday, calendar)) }
        return date.formatted(styled(numeric, calendar))
    }

    /// The time inside a bubble («09:32»).
    static func bubbleTime(_ date: Date, calendar: Calendar = .current) -> String {
        date.formatted(styled(time, calendar))
    }
}
