import Foundation

/// A JSON value as the delivery contract sees it (`mobile/contracts/delivery-state.md` §4): events,
/// server frames and effects are plain JSON. Numbers are doubles, as in JavaScript — the reference
/// reducer is JavaScript, and its `Number.isInteger`, `typeof` and truthiness are mirrored below.
public enum JSONValue: Sendable, Equatable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public static func int(_ value: Int64) -> JSONValue { .number(Double(value)) }

    /// `value` or JSON `null`.
    static func orNull(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
    static func orNull(_ value: Int64?) -> JSONValue { value.map(JSONValue.int) ?? .null }

    // MARK: - JavaScript reads

    /// A JSON string's value (`typeof x === 'string'`); nil for anything else.
    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// An integer number (`Number.isInteger`) that fits a safe integer; nil for anything else.
    var int64: Int64? {
        guard case .number(let value) = self, value.isFinite, value.rounded(.towardZero) == value,
              abs(value) <= 9_007_199_254_740_991 else { return nil }
        return Int64(value)
    }

    /// Any number; NaN for anything else.
    var double: Double {
        if case .number(let value) = self { return value }
        return .nan
    }

    var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var object: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var array: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var isNull: Bool { self == .null }

    /// JavaScript truthiness.
    var isTruthy: Bool {
        switch self {
        case .null: return false
        case .bool(let value): return value
        case .number(let value): return value != 0 && !value.isNaN
        case .string(let value): return !value.isEmpty
        case .array, .object: return true
        }
    }

    subscript(key: String) -> JSONValue? {
        object?[key]
    }

    // MARK: - Text

    /// Parses UTF-8 JSON text; nil when it is not JSON.
    public static func parse(_ data: Data) -> JSONValue? {
        try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    public static func parse(_ text: String) -> JSONValue? {
        parse(Data(text.utf8))
    }

    /// Compact JSON text; integral numbers are written without a fraction.
    public var jsonData: Data {
        // Encoding a JSON value cannot fail: every case maps to a JSON token.
        (try? JSONEncoder().encode(self)) ?? Data("null".utf8)
    }

    public var jsonText: String {
        String(decoding: jsonData, as: UTF8.self)
    }
}

extension JSONValue: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value):
            if let integer = self.int64 {
                try container.encode(integer)
            } else {
                try container.encode(value)
            }
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

// Deliberately not `ExpressibleByNilLiteral`: `nil` must stay "no value" (`JSONValue?`), never turn
// silently into JSON `null` (a `cond ? nil : value` would otherwise become `.null`).
extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int64) { self = .number(Double(value)) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        var object: [String: JSONValue] = [:]
        for (key, value) in elements { object[key] = value }
        self = .object(object)
    }
}

/// A JSON object (frames, events, server records).
public typealias JSONObject = [String: JSONValue]
