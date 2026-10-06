import os

/// Unified logging categories. Use instead of `print` so diagnostics are
/// privacy-redacted by default and filterable in Console.
enum Log {
    private static let subsystem = "kz.centras.centychat"

    static let network = Logger(subsystem: subsystem, category: "network")
    static let realtime = Logger(subsystem: subsystem, category: "realtime")
    static let session = Logger(subsystem: subsystem, category: "session")
    static let chat = Logger(subsystem: subsystem, category: "chat")
    static let delivery = Logger(subsystem: subsystem, category: "delivery")
    static let call = Logger(subsystem: subsystem, category: "call")
    static let announcements = Logger(subsystem: subsystem, category: "announcements")
}
