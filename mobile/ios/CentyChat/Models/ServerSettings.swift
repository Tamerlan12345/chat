import Foundation

/// Общедоступные сведения о сервере CentyChat (GET /api/settings/info)
public struct ServerInfo: Codable, Sendable, Equatable {
    public var serverName: String
    public var companyName: String
    public var allowRegistration: Bool
    public var messageEditWindowMinutes: String
    public var messageDeleteWindowMinutes: String
    public var version: String
    
    public init(
        serverName: String = "CentyChat Server",
        companyName: String = "АО \"Страховая компания \"Сентрас Иншуранс\"",
        allowRegistration: Bool = false,
        messageEditWindowMinutes: String = "60",
        messageDeleteWindowMinutes: String = "60",
        version: String = "1.0.0"
    ) {
        self.serverName = serverName
        self.companyName = companyName
        self.allowRegistration = allowRegistration
        self.messageEditWindowMinutes = messageEditWindowMinutes
        self.messageDeleteWindowMinutes = messageDeleteWindowMinutes
        self.version = version
    }
    
    enum CodingKeys: String, CodingKey {
        case serverName = "server_name"
        case companyName = "company_name"
        case allowRegistration = "allow_registration"
        case messageEditWindowMinutes = "message_edit_window_minutes"
        case messageDeleteWindowMinutes = "message_delete_window_minutes"
        case version
    }
}

/// Статус проверки здоровья сервера (GET /api/health)
public struct HealthResponse: Codable, Sendable {
    public let status: String
    public let error: String?
    
    public var isHealthy: Bool {
        status.lowercased() == "ok"
    }
}
