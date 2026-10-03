import Foundation

/// Нормализация текста для поиска сотрудников: регистр не важен, «ё» равна «е». Свёртка идёт по
/// одному символу и сохраняет длину строки (в символах `Character`), поэтому найденный фрагмент
/// подсвечивается по тем же индексам в исходном имени. Порт `SearchText` (Android).
public enum SearchText {
    public static func normalize(_ text: String) -> String {
        String(normalizedCharacters(text))
    }

    static func normalizedCharacters(_ text: String) -> [Character] {
        text.map { character -> Character in
            let lower = character.lowercased()
            guard lower.count == 1, let folded = lower.first else { return character }
            return folded == "ё" ? "е" : folded
        }
    }

    /// Слова запроса: «Иван  Петров» → [иван, петров]. Все слова должны найтись (И).
    public static func tokens(_ query: String) -> [String] {
        normalize(query)
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
    }

    public static func digits(_ text: String) -> String {
        String(text.filter(isDigit))
    }

    /// Весь запрос — номер телефона, набранный с пробелами («+7 702 303 30 30»).
    public static func isPhoneQuery(_ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return q.filter(isDigit).count >= 3
            && q.allSatisfy { isDigit($0) || $0.isWhitespace || phonePunctuation.contains($0) }
    }

    /// Слово похоже на кусок номера телефона: цифры и знаки «+ ( ) - .».
    public static func isPhoneLike(_ token: String) -> Bool {
        token.contains(where: isDigit) && token.allSatisfy { isDigit($0) || phonePunctuation.contains($0) }
    }

    static func isDigit(_ character: Character) -> Bool {
        guard let scalar = character.unicodeScalars.first, character.unicodeScalars.count == 1 else { return false }
        return scalar.value >= 0x30 && scalar.value <= 0x39
    }

    private static let phonePunctuation: Set<Character> = ["+", "(", ")", "-", "."]
}

/// Поиск подстроки в массиве символов (индексы — в символах, как у подсветки).
func characterIndex(of needle: [Character], in haystack: [Character], from start: Int = 0) -> Int? {
    guard !needle.isEmpty, needle.count <= haystack.count else { return needle.isEmpty ? start : nil }
    var position = max(0, start)
    while position + needle.count <= haystack.count {
        if haystack[position] == needle[0], Array(haystack[position..<(position + needle.count)]) == needle {
            return position
        }
        position += 1
    }
    return nil
}

/// Чем меньше, тем выше в выдаче (спецификация «People surface», раздел Ranking).
public enum MatchRank: Int, Comparable, Sendable {
    /// Начало фамилии или имени (первые два слова ФИО).
    case namePrefix = 0
    /// Начало другого слова ФИО (отчество, вторая часть двойной фамилии).
    case otherTokenPrefix = 1
    /// Подстрока в ФИО.
    case nameSubstring = 2
    /// Логин, должность, отдел, внутренний номер, телефон, почта.
    case otherField = 3

    public static func < (lhs: MatchRank, rhs: MatchRank) -> Bool { lhs.rawValue < rhs.rawValue }
}

public struct PersonMatch: Equatable, Sendable, Identifiable {
    public var person: Person
    public var rank: MatchRank
    /// Найденные части ФИО (индексы символов в `person.fullName`) для подсветки; пусто, если нашлось в другом поле.
    public var highlights: [Range<Int>] = []
    /// Найденное во второй строке («должность · отдел», индексы в `person.subtitle`).
    public var subtitleHighlights: [Range<Int>] = []
    /// Найденное во внутреннем номере (индексы в `person.extension`).
    public var extensionHighlights: [Range<Int>] = []

    public var id: Int64 { person.id }
}

/// Правила поиска сотрудников. Порт `PeopleSearch` (Android).
public enum PeopleSearch {
    /// Совпадение одного человека со всем запросом или nil. Пустой запрос не совпадает ни с кем.
    public static func match(_ person: Person, query: String) -> PersonMatch? {
        let tokens = SearchText.tokens(query)
        if tokens.isEmpty { return nil }
        return match(person, tokens: tokens) ?? phoneMatch(person, query: query)
    }

    /// Выдача по запросу: ранг, внутри ранга — сначала те, кто в сети (и «отошёл»), затем по
    /// алфавиту. Пустой запрос — все по алфавиту.
    public static func rank(_ people: [Person], query: String) -> [PersonMatch] {
        let tokens = SearchText.tokens(query)
        if tokens.isEmpty {
            return people.sorted(by: NameOrder.precedes).map { PersonMatch(person: $0, rank: .namePrefix) }
        }
        return people
            .compactMap { match($0, tokens: tokens) ?? phoneMatch($0, query: query) }
            .sorted(by: resultOrder)
    }

    /// Подходит ли человек под запрос (для фильтра дерева отделов).
    public static func matches(_ person: Person, query: String) -> Bool {
        let tokens = SearchText.tokens(query)
        return tokens.isEmpty || match(person, tokens: tokens) != nil || phoneMatch(person, query: query) != nil
    }

    /// Номер, набранный с пробелами: его цифры ищутся одним куском в цифрах телефона.
    private static func phoneMatch(_ person: Person, query: String) -> PersonMatch? {
        guard SearchText.isPhoneQuery(query), let phone = person.phone else { return nil }
        return SearchText.digits(phone).contains(SearchText.digits(query))
            ? PersonMatch(person: person, rank: .otherField)
            : nil
    }

    private static func resultOrder(_ a: PersonMatch, _ b: PersonMatch) -> Bool {
        if a.rank != b.rank { return a.rank < b.rank }
        let aOnline = a.person.status.isReachable
        let bOnline = b.person.status.isReachable
        if aOnline != bOnline { return aOnline }
        return NameOrder.precedes(a.person, b.person)
    }

    private static func match(_ person: Person, tokens: [String]) -> PersonMatch? {
        let name = SearchText.normalizedCharacters(person.fullName)
        let words = wordsOf(name)
        var worst = MatchRank.namePrefix
        var highlights: [Range<Int>] = []
        let subtitle = SearchText.normalizedCharacters(person.subtitle)
        let extensionText = person.extension.map(SearchText.normalizedCharacters)
        var subtitleHits: [Range<Int>] = []
        var extensionHits: [Range<Int>] = []
        for token in tokens {
            let needle = Array(token)
            guard let found = matchToken(person, name: name, words: words, token: needle, highlights: &highlights) else {
                return nil
            }
            if found > worst { worst = found }
            if found == .otherField {
                if let at = characterIndex(of: needle, in: subtitle) {
                    subtitleHits.append(at..<(at + needle.count))
                }
                if let extensionText, let at = characterIndex(of: needle, in: extensionText) {
                    extensionHits.append(at..<(at + needle.count))
                }
            }
        }
        return PersonMatch(
            person: person,
            rank: worst,
            highlights: unique(highlights.sorted { $0.lowerBound < $1.lowerBound }),
            subtitleHighlights: subtitleHits.sorted { $0.lowerBound < $1.lowerBound },
            extensionHighlights: extensionHits.sorted { $0.lowerBound < $1.lowerBound }
        )
    }

    private static func unique(_ ranges: [Range<Int>]) -> [Range<Int>] {
        var seen: [Range<Int>] = []
        for range in ranges where !seen.contains(range) {
            seen.append(range)
        }
        return seen
    }

    private static func matchToken(
        _ person: Person,
        name: [Character],
        words: [Word],
        token: [Character],
        highlights: inout [Range<Int>]
    ) -> MatchRank? {
        if let word = words.first(where: { $0.text.starts(with: token) }) {
            highlights.append(word.start..<(word.start + token.count))
            return word.index <= 1 && !word.isPart ? .namePrefix : .otherTokenPrefix
        }
        if let at = characterIndex(of: token, in: name) {
            highlights.append(at..<(at + token.count))
            return .nameSubstring
        }
        return matchesOtherField(person, token: String(token)) ? .otherField : nil
    }

    private static func matchesOtherField(_ person: Person, token: String) -> Bool {
        let plain: [String?] = [person.username, person.jobTitle, person.departmentName, person.extension, person.email]
        if plain.contains(where: { value in value.map { SearchText.normalize($0).contains(token) } ?? false }) {
            return true
        }
        guard let phone = person.phone, SearchText.isPhoneLike(token) else { return false }
        let digits = SearchText.digits(token)
        return digits.count >= 3 && SearchText.digits(phone).contains(digits)
    }

    private struct Word {
        let text: [Character]
        let start: Int
        let index: Int
        let isPart: Bool
    }

    /// Слова ФИО с позициями; части двойной фамилии («Петрова-Водкина») — отдельно, как «другие слова».
    private static func wordsOf(_ name: [Character]) -> [Word] {
        var words: [Word] = []
        var index = 0
        var i = 0
        while i < name.count {
            if name[i].isWhitespace {
                i += 1
                continue
            }
            let start = i
            while i < name.count && !name[i].isWhitespace { i += 1 }
            let word = Array(name[start..<i])
            words.append(Word(text: word, start: start, index: index, isPart: false))
            for (offset, character) in word.enumerated() where character == "-" && offset + 1 < word.count {
                let partStart = offset + 1
                words.append(Word(text: Array(word[partStart...]), start: start + partStart, index: index, isPart: true))
            }
            index += 1
        }
        return words
    }
}

/// Алфавитный порядок имён, одинаковый на всех клиентах: сначала кириллица (А–Я, «ё» как «е»),
/// затем латиница, затем цифры и прочее. Пробел раньше любой буквы: «Иванов Борис» < «Иванова Алла».
public enum NameOrder {
    public static func compare(_ a: String, _ b: String) -> Int {
        let x = SearchText.normalizedCharacters(a.trimmingCharacters(in: .whitespacesAndNewlines))
        let y = SearchText.normalizedCharacters(b.trimmingCharacters(in: .whitespacesAndNewlines))
        let n = min(x.count, y.count)
        for i in 0..<n {
            let diff = weight(x[i]) - weight(y[i])
            if diff != 0 { return diff }
        }
        return x.count - y.count
    }

    public static func precedes(_ a: String, _ b: String) -> Bool {
        compare(a, b) < 0
    }

    /// По имени, при равных именах — по id, чтобы порядок не зависел от сортировки.
    static func precedes(_ a: Person, _ b: Person) -> Bool {
        let order = compare(a.fullName, b.fullName)
        return order != 0 ? order < 0 : a.id < b.id
    }

    /// Группа первой буквы для разделов списка: 0 — кириллица, 1 — латиница, 2 — прочее.
    public static func script(_ character: Character) -> Int {
        let normalized = SearchText.normalizedCharacters(String(character)).first ?? character
        let value = normalized.unicodeScalars.first?.value ?? 0
        if (0x0430...0x044F).contains(value) { return 0 }
        if (0x61...0x7A).contains(value) { return 1 }
        return 2
    }

    private static func weight(_ character: Character) -> Int {
        let value = Int(character.unicodeScalars.first?.value ?? 0)
        switch value {
        case 0x0430...0x044F: return 1_000 + (value - 0x0430)
        case 0x61...0x7A: return 2_000 + (value - 0x61)
        case 0x30...0x39: return 3_000 + (value - 0x30)
        default:
            return character.isWhitespace || character == "-" || character == "." ? 0 : 4_000 + value
        }
    }
}
