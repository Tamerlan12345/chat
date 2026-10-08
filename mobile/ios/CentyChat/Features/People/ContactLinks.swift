import Foundation

/// Ссылки «набрать номер» и «написать письмо» из строк сервера. Строка проверяется и собирается
/// через `URLComponents`, а не склеивается: `mailto:` из сырой строки мог бы нести лишние
/// параметры (`?subject=…&body=…`), `tel:` — что угодно кроме номера. Порт `ContactLinks` (Android).
public enum ContactLinks {
    /// Номер для набора: только цифры и «+» в начале; меньше трёх цифр — не номер.
    public static func phoneNumber(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = SearchText.digits(trimmed)
        guard digits.count >= 3, digits.count <= 20 else { return nil }
        let allowed = trimmed.allSatisfy { SearchText.isDigit($0) || $0.isWhitespace || "+-().".contains($0) }
        guard allowed else { return nil }
        return trimmed.hasPrefix("+") ? "+" + digits : digits
    }

    public static func email(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count <= 254 else { return nil }
        let forbidden: Set<Character> = ["@", "?", "&", "#", "/", ":"]
        let parts = trimmed.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let local = parts[0]
        let domain = parts[1]
        func clean(_ part: Substring) -> Bool {
            !part.isEmpty && !part.contains(where: { $0.isWhitespace || forbidden.contains($0) })
        }
        guard clean(local), clean(domain) else { return nil }
        // Домен — хотя бы «x.y», без пустых краёв вокруг точки.
        let hasInnerDot = domain.indices.contains { index in
            domain[index] == "." && index != domain.startIndex && domain.index(after: index) != domain.endIndex
        }
        guard hasInnerDot else { return nil }
        return trimmed
    }

    public static func dial(_ raw: String) -> URL? {
        guard let number = phoneNumber(raw) else { return nil }
        var components = URLComponents()
        components.scheme = "tel"
        components.path = number
        return components.url
    }

    public static func mail(_ raw: String) -> URL? {
        guard let address = email(raw) else { return nil }
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = address
        guard let url = components.url, url.query == nil, url.fragment == nil else { return nil }
        return url
    }
}
