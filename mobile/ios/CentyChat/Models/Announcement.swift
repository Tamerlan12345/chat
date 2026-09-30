import Foundation

/// Целевая аудитория оповещения
public enum AnnouncementTarget: String, Codable, Sendable, CaseIterable {
    case all
    case departments
    case users
    
    public var displayName: String {
        switch self {
        case .all: return "Всем сотрудникам"
        case .departments: return "Подразделениям"
        case .users: return "Выбранным сотрудникам"
        }
    }
}

/// Приоритет важности оповещения
public enum AnnouncementPriority: String, Codable, Sendable, CaseIterable, Comparable {
    case normal
    case urgent
    case critical
    
    public var displayName: String {
        switch self {
        case .normal: return "Обычный"
        case .urgent: return "Срочный"
        case .critical: return "Критический"
        }
    }
    
    private var sortOrder: Int {
        switch self {
        case .normal: return 0
        case .urgent: return 1
        case .critical: return 2
        }
    }
    
    public static func < (lhs: AnnouncementPriority, rhs: AnnouncementPriority) -> Bool {
        lhs.sortOrder < rhs.sortOrder
    }
}

/// Корпоративное оповещение (распоряжение) CentyChat
public struct Announcement: Identifiable, Codable, Sendable, Equatable, Hashable {
    public let id: Int64
    public var authorId: Int64
    public var title: String
    public var content: String
    public var targetType: AnnouncementTarget
    public var priority: AnnouncementPriority
    public var expiresAt: Date?
    public var createdAt: Date
    public var authorName: String
    public var authorJobTitle: String?
    public var confirmedAt: Date?
    public var isConfirmed: Bool
    
    public init(
        id: Int64,
        authorId: Int64,
        title: String,
        content: String,
        targetType: AnnouncementTarget = .all,
        priority: AnnouncementPriority = .normal,
        expiresAt: Date? = nil,
        createdAt: Date = Date(),
        authorName: String,
        authorJobTitle: String? = nil,
        confirmedAt: Date? = nil,
        isConfirmed: Bool = false
    ) {
        self.id = id
        self.authorId = authorId
        self.title = title
        self.content = content
        self.targetType = targetType
        self.priority = priority
        self.expiresAt = expiresAt
        self.createdAt = createdAt
        self.authorName = authorName
        self.authorJobTitle = authorJobTitle
        self.confirmedAt = confirmedAt
        self.isConfirmed = isConfirmed
    }
    
    enum CodingKeys: String, CodingKey {
        case id
        case authorId = "author_id"
        case title
        case content
        case targetType = "target_type"
        case priority
        case expiresAt = "expires_at"
        case createdAt = "created_at"
        case authorName = "author_name"
        case authorJobTitle = "author_job_title"
        case confirmedAt = "confirmed_at"
        case isConfirmed = "is_confirmed"
    }
    
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(Int64.self, forKey: .id)
        self.authorId = try container.decode(Int64.self, forKey: .authorId)
        self.title = try container.decode(String.self, forKey: .title)
        self.content = try container.decode(String.self, forKey: .content)
        self.targetType = try container.decodeIfPresent(AnnouncementTarget.self, forKey: .targetType) ?? .all
        self.priority = try container.decodeIfPresent(AnnouncementPriority.self, forKey: .priority) ?? .normal
        
        if let expStr = try container.decodeIfPresent(String.self, forKey: .expiresAt) {
            self.expiresAt = DateParser.parse(expStr)
        } else {
            self.expiresAt = nil
        }
        
        if let createdStr = try container.decodeIfPresent(String.self, forKey: .createdAt) {
            self.createdAt = DateParser.parse(createdStr) ?? Date()
        } else {
            self.createdAt = Date()
        }
        
        self.authorName = try container.decodeIfPresent(String.self, forKey: .authorName) ?? "Администрация"
        self.authorJobTitle = try container.decodeIfPresent(String.self, forKey: .authorJobTitle)
        
        if let confStr = try container.decodeIfPresent(String.self, forKey: .confirmedAt) {
            self.confirmedAt = DateParser.parse(confStr)
        } else {
            self.confirmedAt = nil
        }
        
        if let confInt = try? container.decode(Int.self, forKey: .isConfirmed) {
            self.isConfirmed = (confInt != 0)
        } else if let confBool = try? container.decode(Bool.self, forKey: .isConfirmed) {
            self.isConfirmed = confBool
        } else {
            self.isConfirmed = false
        }
    }
    
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(authorId, forKey: .authorId)
        try container.encode(title, forKey: .title)
        try container.encode(content, forKey: .content)
        try container.encode(targetType, forKey: .targetType)
        try container.encode(priority, forKey: .priority)
        if let expiresAt = expiresAt {
            try container.encode(DateParser.format(expiresAt), forKey: .expiresAt)
        }
        try container.encode(DateParser.format(createdAt), forKey: .createdAt)
        try container.encode(authorName, forKey: .authorName)
        try container.encodeIfPresent(authorJobTitle, forKey: .authorJobTitle)
        if let confirmedAt = confirmedAt {
            try container.encode(DateParser.format(confirmedAt), forKey: .confirmedAt)
        }
        try container.encode(isConfirmed ? 1 : 0, forKey: .isConfirmed)
    }
}

/// Ответ сервера при подтверждении ознакомления
public struct AnnouncementAckResponse: Codable, Sendable {
    public let success: Bool
    public let announcementId: Int64
    public let confirmedAt: String
    
    enum CodingKeys: String, CodingKey {
        case success
        case announcementId
        case confirmedAt = "confirmed_at"
    }
}
