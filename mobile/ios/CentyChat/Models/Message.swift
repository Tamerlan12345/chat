import Foundation

/// Тип беседы: личный диалог или корпоративный канал
public enum ConversationType: String, Codable, Sendable, CaseIterable {
    case direct
    case channel
}

/// Тип контента сообщения
public enum MessageType: String, Codable, Sendable, CaseIterable {
    case text
    case file
    case image
}

/// Статус доставки сообщения
public enum DeliveryStatus: String, Codable, Sendable, CaseIterable {
    case sending
    case sent
    case delivered
    case read
}

/// Where an own message stands before the server confirmed it (`delivery-state.md` §3.4).
public enum SendState: String, Sendable, Equatable, Hashable {
    /// In the queue («Ожидает отправки»).
    case queued
    /// On its way («Отправляется»).
    case sending
    /// Not sent («Не отправлено», «Повторить» / «Удалить»).
    case failed
}

/// The quoted original of a reply, as the desktop shows it (found among the loaded messages).
public struct ReplyQuote: Sendable, Equatable, Hashable {
    public let senderName: String
    public let text: String
}

/// A file of this device on its way to the server: drawn from the local copy.
public struct LocalUpload: Sendable, Equatable, Hashable {
    public let fileURL: URL
    public let name: String
    public let size: Int64?
    public let mimeType: String?
    /// 0…1 while it is going up.
    public let progress: Double?
}

/// Метаданные вложения сообщения
public struct MessageMetadata: Codable, Sendable, Equatable, Hashable {
    public var fileId: Int64?
    public var fileName: String?
    public var fileSize: Int64?
    public var mimeType: String?
    public var url: String?
    
    public init(
        fileId: Int64? = nil,
        fileName: String? = nil,
        fileSize: Int64? = nil,
        mimeType: String? = nil,
        url: String? = nil
    ) {
        self.fileId = fileId
        self.fileName = fileName
        self.fileSize = fileSize
        self.mimeType = mimeType
        self.url = url
    }
    
    enum CodingKeys: String, CodingKey {
        case fileId = "file_id"
        case fileName = "file_name"
        case fileSize = "size"
        case mimeType = "mime_type"
        case url
    }
}

/// Сообщение чата CentyChat
public struct Message: Identifiable, Codable, Sendable, Equatable, Hashable {
    public let id: Int64
    public var conversationType: ConversationType
    public var targetId: Int64
    public var senderId: Int64
    public var text: String
    public var type: MessageType
    public var replyToId: Int64?
    public var metadataJson: String?
    public var metadata: MessageMetadata?
    public var createdAt: Date
    public var updatedAt: Date?
    public var isDeleted: Bool
    public var senderUsername: String?
    public var senderName: String
    public var senderAvatar: String?
    public var senderDepartment: String?
    public var fileOriginalName: String?
    public var fileWidth: Int?
    public var fileHeight: Int?
    public var deliveryStatus: DeliveryStatus?
    /// The idempotency key the message was sent with (`client_msg_id`); the row's identity.
    public var clientMsgId: String?
    /// Set only for an own message the server has not confirmed yet.
    public var sendState: SendState?
    /// Why a failed message was not sent (the server's words), for the bubble.
    public var failureReason: String?
    /// The quoted original of a reply.
    public var replyQuote: ReplyQuote?
    /// The local file of an attachment still on its way.
    public var localUpload: LocalUpload?
    /// The raw `metadata` of an unsent attachment (`{ file_id, size, mimeType, url, … }`).
    public var pendingMetadata: JSONValue?

    /// The row's identity: `client_msg_id` when there is one, so a bubble does not jump when the
    /// server's record replaces the local one (`delivery-state.md` §3.4).
    public var rowID: String {
        clientMsgId.map { "key:\($0)" } ?? "id:\(id)"
    }
    
    public init(
        id: Int64,
        conversationType: ConversationType,
        targetId: Int64,
        senderId: Int64,
        text: String,
        type: MessageType = .text,
        replyToId: Int64? = nil,
        metadataJson: String? = nil,
        metadata: MessageMetadata? = nil,
        createdAt: Date = Date(),
        updatedAt: Date? = nil,
        isDeleted: Bool = false,
        senderUsername: String? = nil,
        senderName: String,
        senderAvatar: String? = nil,
        senderDepartment: String? = nil,
        fileOriginalName: String? = nil,
        deliveryStatus: DeliveryStatus? = nil,
        clientMsgId: String? = nil,
        sendState: SendState? = nil
    ) {
        self.id = id
        self.conversationType = conversationType
        self.targetId = targetId
        self.senderId = senderId
        self.text = text
        self.type = type
        self.replyToId = replyToId
        self.metadataJson = metadataJson
        self.metadata = metadata
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.isDeleted = isDeleted
        self.senderUsername = senderUsername
        self.senderName = senderName
        self.senderAvatar = senderAvatar
        self.senderDepartment = senderDepartment
        self.fileOriginalName = fileOriginalName
        self.deliveryStatus = deliveryStatus
        self.clientMsgId = clientMsgId
        self.sendState = sendState
    }
    
    enum CodingKeys: String, CodingKey {
        case id
        case conversationType = "conversation_type"
        case targetId = "target_id"
        case senderId = "sender_id"
        case text
        case type
        case replyToId = "reply_to_id"
        case metadataJson = "metadata_json"
        case metadata
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case isDeleted = "is_deleted"
        case senderUsername = "sender_username"
        case senderName = "sender_name"
        case senderAvatar = "sender_avatar"
        case senderDepartment = "sender_department"
        case fileOriginalName = "file_original_name"
        case fileWidth = "file_width"
        case fileHeight = "file_height"
        case deliveryStatus = "delivery_status"
        case clientMsgId = "client_msg_id"
    }
    
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(Int64.self, forKey: .id)
        self.conversationType = try container.decodeIfPresent(ConversationType.self, forKey: .conversationType) ?? .direct
        self.targetId = try container.decode(Int64.self, forKey: .targetId)
        self.senderId = try container.decode(Int64.self, forKey: .senderId)
        self.text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
        self.type = try container.decodeIfPresent(MessageType.self, forKey: .type) ?? .text
        self.replyToId = try container.decodeIfPresent(Int64.self, forKey: .replyToId)
        self.metadataJson = try container.decodeIfPresent(String.self, forKey: .metadataJson)
        
        // Try decoding metadata directly, or from metadataJson string
        if let directMeta = try? container.decodeIfPresent(MessageMetadata.self, forKey: .metadata) {
            self.metadata = directMeta
        } else if let jsonString = metadataJson, let data = jsonString.data(using: .utf8) {
            self.metadata = try? JSONDecoder().decode(MessageMetadata.self, from: data)
        } else {
            self.metadata = nil
        }
        
        if let createdStr = try container.decodeIfPresent(String.self, forKey: .createdAt) {
            self.createdAt = DateParser.parse(createdStr) ?? Date()
        } else {
            self.createdAt = Date()
        }
        
        if let updatedStr = try container.decodeIfPresent(String.self, forKey: .updatedAt) {
            self.updatedAt = DateParser.parse(updatedStr)
        } else {
            self.updatedAt = nil
        }
        
        if let delInt = try? container.decode(Int.self, forKey: .isDeleted) {
            self.isDeleted = (delInt != 0)
        } else if let delBool = try? container.decode(Bool.self, forKey: .isDeleted) {
            self.isDeleted = delBool
        } else {
            self.isDeleted = false
        }
        
        self.senderUsername = try container.decodeIfPresent(String.self, forKey: .senderUsername)
        self.senderName = try container.decodeIfPresent(String.self, forKey: .senderName) ?? String(localized: "Пользователь")
        self.senderAvatar = try container.decodeIfPresent(String.self, forKey: .senderAvatar)
        self.senderDepartment = try container.decodeIfPresent(String.self, forKey: .senderDepartment)
        self.fileOriginalName = try container.decodeIfPresent(String.self, forKey: .fileOriginalName)
        self.fileWidth = try? container.decodeIfPresent(Int.self, forKey: .fileWidth)
        self.fileHeight = try? container.decodeIfPresent(Int.self, forKey: .fileHeight)
        self.deliveryStatus = try? container.decodeIfPresent(DeliveryStatus.self, forKey: .deliveryStatus)
        self.clientMsgId = try? container.decodeIfPresent(String.self, forKey: .clientMsgId)
    }
    
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(conversationType, forKey: .conversationType)
        try container.encode(targetId, forKey: .targetId)
        try container.encode(senderId, forKey: .senderId)
        try container.encode(text, forKey: .text)
        try container.encode(type, forKey: .type)
        try container.encodeIfPresent(replyToId, forKey: .replyToId)
        try container.encodeIfPresent(metadataJson, forKey: .metadataJson)
        try container.encodeIfPresent(metadata, forKey: .metadata)
        try container.encode(DateParser.format(createdAt), forKey: .createdAt)
        if let updatedAt = updatedAt {
            try container.encode(DateParser.format(updatedAt), forKey: .updatedAt)
        }
        try container.encode(isDeleted ? 1 : 0, forKey: .isDeleted)
        try container.encodeIfPresent(senderUsername, forKey: .senderUsername)
        try container.encode(senderName, forKey: .senderName)
        try container.encodeIfPresent(senderAvatar, forKey: .senderAvatar)
        try container.encodeIfPresent(senderDepartment, forKey: .senderDepartment)
        try container.encodeIfPresent(fileOriginalName, forKey: .fileOriginalName)
        try container.encodeIfPresent(fileWidth, forKey: .fileWidth)
        try container.encodeIfPresent(fileHeight, forKey: .fileHeight)
        try container.encodeIfPresent(deliveryStatus, forKey: .deliveryStatus)
        try container.encodeIfPresent(clientMsgId, forKey: .clientMsgId)
    }
}
