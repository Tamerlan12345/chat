import Foundation

/// Ответ сервера при загрузке файла (POST /api/files/upload)
public struct FileUploadResponse: Identifiable, Codable, Sendable {
    public let id: Int64
    public let originalName: String
    public let storedFilename: String
    public let fileSize: Int64
    public let mimeType: String
    public let url: String
    /// Images only (T20): pixel size and the dominant colour for a placeholder.
    public var width: Int?
    public var height: Int?
    public var dominantColor: String?

    enum CodingKeys: String, CodingKey {
        case id
        case originalName
        case storedFilename
        case fileSize
        case mimeType
        case url
        case width
        case height
        case dominantColor
    }
}

/// `POST /api/devices/push-token` → `{ registered, push_enabled }` (`push.md` §2).
public struct PushTokenRegisterResponse: Codable, Sendable, Equatable {
    public let registered: Bool
    public let pushEnabled: Bool

    enum CodingKeys: String, CodingKey {
        case registered
        case pushEnabled = "push_enabled"
    }
}

/// `DELETE /api/devices/push-token` → `{ removed }`; someone else's token is also `false`.
public struct PushTokenDeleteResponse: Codable, Sendable, Equatable {
    public let removed: Bool
}

/// Действующая политика разрешенных файлов (GET /api/files/policy)
public struct FilePolicyEffectiveResponse: Codable, Sendable {
    public let enabled: Bool
    public let allowed: [String]
    
    public init(enabled: Bool = true, allowed: [String] = ["pdf", "docx", "xlsx", "png", "jpg", "jpeg", "zip"]) {
        self.enabled = enabled
        self.allowed = allowed
    }
    
    /// Локальная проверка расширения файла перед загрузкой
    public func isExtensionAllowed(_ ext: String) -> Bool {
        guard enabled else { return true }
        let cleanExt = ext.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return allowed.map { $0.lowercased() }.contains(cleanExt)
    }
}

/// Локальная модель вложения для отправки
public struct PendingAttachment: Identifiable, Sendable {
    public let id = UUID()
    public let fileName: String
    public let fileData: Data
    public let mimeType: String
    public let isImage: Bool
    
    public init(fileName: String, fileData: Data, mimeType: String, isImage: Bool) {
        self.fileName = fileName
        self.fileData = fileData
        self.mimeType = mimeType
        self.isImage = isImage
    }
    
    public var fileSize: Int64 {
        Int64(fileData.count)
    }
}
