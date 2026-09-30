import Foundation

/// Диалог в списке личных чатов (DirectConversation)
public struct DirectConversation: Identifiable, Codable, Sendable, Equatable, Hashable {
    public var id: Int64 { userId }
    public let userId: Int64
    public var username: String?
    public var fullName: String
    public var avatarUrl: String?
    public var status: UserStatus
    public var customStatus: String?
    public var jobTitle: String?
    public var departmentName: String?
    public var lastMessageId: Int64?
    public var lastMessageText: String?
    public var lastMessageTime: Date?
    public var lastMessageSenderId: Int64?
    public var lastMessageType: MessageType?
    public var unreadCount: Int
    
    public init(
        userId: Int64,
        username: String? = nil,
        fullName: String,
        avatarUrl: String? = nil,
        status: UserStatus = .offline,
        customStatus: String? = nil,
        jobTitle: String? = nil,
        departmentName: String? = nil,
        lastMessageId: Int64? = nil,
        lastMessageText: String? = nil,
        lastMessageTime: Date? = nil,
        lastMessageSenderId: Int64? = nil,
        lastMessageType: MessageType? = nil,
        unreadCount: Int = 0
    ) {
        self.userId = userId
        self.username = username
        self.fullName = fullName
        self.avatarUrl = avatarUrl
        self.status = status
        self.customStatus = customStatus
        self.jobTitle = jobTitle
        self.departmentName = departmentName
        self.lastMessageId = lastMessageId
        self.lastMessageText = lastMessageText
        self.lastMessageTime = lastMessageTime
        self.lastMessageSenderId = lastMessageSenderId
        self.lastMessageType = lastMessageType
        self.unreadCount = unreadCount
    }
    
    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case username
        case fullName = "full_name"
        case avatarUrl = "avatar_url"
        case status
        case customStatus = "custom_status"
        case jobTitle = "job_title"
        case departmentName = "department_name"
        case lastMessageId = "last_message_id"
        case lastMessageText = "last_message_text"
        case lastMessageTime = "last_message_time"
        case lastMessageSenderId = "last_message_sender_id"
        case lastMessageType = "last_message_type"
        case unreadCount = "unread_count"
    }
    
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.userId = try container.decode(Int64.self, forKey: .userId)
        self.username = try container.decodeIfPresent(String.self, forKey: .username)
        self.fullName = try container.decodeIfPresent(String.self, forKey: .fullName) ?? "Пользователь"
        self.avatarUrl = try container.decodeIfPresent(String.self, forKey: .avatarUrl)
        self.status = try container.decodeIfPresent(UserStatus.self, forKey: .status) ?? .offline
        self.customStatus = try container.decodeIfPresent(String.self, forKey: .customStatus)
        self.jobTitle = try container.decodeIfPresent(String.self, forKey: .jobTitle)
        self.departmentName = try container.decodeIfPresent(String.self, forKey: .departmentName)
        self.lastMessageId = try container.decodeIfPresent(Int64.self, forKey: .lastMessageId)
        self.lastMessageText = try container.decodeIfPresent(String.self, forKey: .lastMessageText)
        
        if let timeStr = try container.decodeIfPresent(String.self, forKey: .lastMessageTime) {
            self.lastMessageTime = DateParser.parse(timeStr)
        } else {
            self.lastMessageTime = nil
        }
        
        self.lastMessageSenderId = try container.decodeIfPresent(Int64.self, forKey: .lastMessageSenderId)
        self.lastMessageType = try container.decodeIfPresent(MessageType.self, forKey: .lastMessageType)
        self.unreadCount = try container.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0
    }
    
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(userId, forKey: .userId)
        try container.encodeIfPresent(username, forKey: .username)
        try container.encode(fullName, forKey: .fullName)
        try container.encodeIfPresent(avatarUrl, forKey: .avatarUrl)
        try container.encode(status, forKey: .status)
        try container.encodeIfPresent(customStatus, forKey: .customStatus)
        try container.encodeIfPresent(jobTitle, forKey: .jobTitle)
        try container.encodeIfPresent(departmentName, forKey: .departmentName)
        try container.encodeIfPresent(lastMessageId, forKey: .lastMessageId)
        try container.encodeIfPresent(lastMessageText, forKey: .lastMessageText)
        if let lastMessageTime = lastMessageTime {
            try container.encode(DateParser.format(lastMessageTime), forKey: .lastMessageTime)
        }
        try container.encodeIfPresent(lastMessageSenderId, forKey: .lastMessageSenderId)
        try container.encodeIfPresent(lastMessageType, forKey: .lastMessageType)
        try container.encode(unreadCount, forKey: .unreadCount)
    }
}
