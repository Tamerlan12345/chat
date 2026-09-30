import Foundation

/// Тип корпоративного канала
public enum ChannelType: String, Codable, Sendable, CaseIterable {
    case `public`
    case `private`
    case system
    
    public var displayName: String {
        switch self {
        case .public: return "Публичный"
        case .private: return "Приватный"
        case .system: return "Системный"
        }
    }
}

/// Корпоративный канал CentyChat
public struct Channel: Identifiable, Codable, Sendable, Equatable, Hashable {
    public let id: Int64
    public var name: String
    public var topic: String?
    public var type: ChannelType
    public var ownerId: Int64?
    public var createdAt: Date
    public var memberRole: String?
    public var membersCount: Int
    public var unreadCount: Int
    public var lastMessageText: String?
    public var lastMessageTime: Date?
    
    public init(
        id: Int64,
        name: String,
        topic: String? = nil,
        type: ChannelType = .public,
        ownerId: Int64? = nil,
        createdAt: Date = Date(),
        memberRole: String? = nil,
        membersCount: Int = 0,
        unreadCount: Int = 0,
        lastMessageText: String? = nil,
        lastMessageTime: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.topic = topic
        self.type = type
        self.ownerId = ownerId
        self.createdAt = createdAt
        self.memberRole = memberRole
        self.membersCount = membersCount
        self.unreadCount = unreadCount
        self.lastMessageText = lastMessageText
        self.lastMessageTime = lastMessageTime
    }
    
    enum CodingKeys: String, CodingKey {
        case id
        case name
        case topic
        case type
        case ownerId = "owner_id"
        case createdAt = "created_at"
        case memberRole = "member_role"
        case membersCount = "members_count"
        case unreadCount = "unread_count"
        case lastMessageText = "last_message_text"
        case lastMessageTime = "last_message_time"
    }
    
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(Int64.self, forKey: .id)
        self.name = try container.decode(String.self, forKey: .name)
        self.topic = try container.decodeIfPresent(String.self, forKey: .topic)
        self.type = try container.decodeIfPresent(ChannelType.self, forKey: .type) ?? .public
        self.ownerId = try container.decodeIfPresent(Int64.self, forKey: .ownerId)
        
        if let createdStr = try container.decodeIfPresent(String.self, forKey: .createdAt) {
            self.createdAt = DateParser.parse(createdStr) ?? Date()
        } else {
            self.createdAt = Date()
        }
        
        self.memberRole = try container.decodeIfPresent(String.self, forKey: .memberRole)
        self.membersCount = try container.decodeIfPresent(Int.self, forKey: .membersCount) ?? 0
        self.unreadCount = try container.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0
        self.lastMessageText = try container.decodeIfPresent(String.self, forKey: .lastMessageText)
        
        if let lastTimeStr = try container.decodeIfPresent(String.self, forKey: .lastMessageTime) {
            self.lastMessageTime = DateParser.parse(lastTimeStr)
        } else {
            self.lastMessageTime = nil
        }
    }
    
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encodeIfPresent(topic, forKey: .topic)
        try container.encode(type, forKey: .type)
        try container.encodeIfPresent(ownerId, forKey: .ownerId)
        try container.encode(DateParser.format(createdAt), forKey: .createdAt)
        try container.encodeIfPresent(memberRole, forKey: .memberRole)
        try container.encode(membersCount, forKey: .membersCount)
        try container.encode(unreadCount, forKey: .unreadCount)
        try container.encodeIfPresent(lastMessageText, forKey: .lastMessageText)
        if let lastMessageTime = lastMessageTime {
            try container.encode(DateParser.format(lastMessageTime), forKey: .lastMessageTime)
        }
    }
}
