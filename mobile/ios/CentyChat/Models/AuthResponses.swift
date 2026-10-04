import Foundation

/// Запрос device knock при запуске приложения
public struct KnockRequest: Codable, Sendable {
    public let deviceId: String
    public let deviceSecret: String?
    public let deviceName: String
    public let platform: String
    public let clientVersion: String
    
    public init(
        deviceId: String,
        deviceSecret: String? = nil,
        deviceName: String,
        platform: String = "iOS",
        clientVersion: String = "1.0.0"
    ) {
        self.deviceId = deviceId
        self.deviceSecret = deviceSecret
        self.deviceName = deviceName
        self.platform = platform
        self.clientVersion = clientVersion
    }
    
    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case deviceSecret = "device_secret"
        case deviceName = "device_name"
        case platform
        case clientVersion = "client_version"
    }
}

/// Статус ответа на knock
public enum KnockStatus: String, Codable, Sendable {
    case paired
    case loginRequired = "login_required"
    case pending
    case tooManyPending = "too_many_pending"
}

/// Ответ сервера на knock
public struct KnockResponse: Codable, Sendable {
    public let status: KnockStatus
    public let message: String?
    public let deviceId: String?
    public let deviceName: String?
    public let user: User?
    public let token: String?
    
    enum CodingKeys: String, CodingKey {
        case status
        case message
        case deviceId = "device_id"
        case deviceName = "device_name"
        case user
        case token
    }
}

/// Запрос привязки секрета устройства (POST /api/auth/device/claim)
public struct DeviceClaimRequest: Codable, Sendable {
    public let deviceId: String
    public let deviceSecret: String
    
    public init(deviceId: String, deviceSecret: String) {
        self.deviceId = deviceId
        self.deviceSecret = deviceSecret
    }
    
    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case deviceSecret = "device_secret"
    }
}

/// Запрос аутентификации по логину и паролю
public struct LoginRequest: Codable, Sendable {
    public let username: String
    public let password: String
    
    public init(username: String, password: String) {
        self.username = username
        self.password = password
    }
}

/// Ответ успешной аутентификации
public struct AuthSuccessResponse: Codable, Sendable {
    public let user: User
    public let token: String
}

/// Ответ продления токена (POST /api/auth/refresh)
public struct RefreshTokenResponse: Codable, Sendable {
    public let token: String
}

/// Запрос на смену пароля (POST /api/users/password)
public struct ChangePasswordRequest: Codable, Sendable {
    public let oldPassword: String
    public let newPassword: String
    
    public init(oldPassword: String, newPassword: String) {
        self.oldPassword = oldPassword
        self.newPassword = newPassword
    }
}

/// Ответ на смену пароля
public struct ChangePasswordResponse: Codable, Sendable {
    public let success: Bool
    public let message: String
    public let token: String
    public let user: User
}

/// Стандартный ответ сервера с ошибкой
public struct ServerErrorResponse: Codable, Sendable {
    public let error: String
    public let code: String?
    /// Wrong e-mail code: attempts that are still left (400 CODE_INVALID).
    public let attemptsLeft: Int?
}

/// Ответ привязки секрета устройства (POST /api/auth/device/claim)
public struct DeviceClaimResponse: Codable, Sendable {
    public let claimed: Bool
}

/// Ответ `{ success }` (например, POST /api/auth/logout)
public struct SuccessResponse: Codable, Sendable {
    public let success: Bool
}

/// Профиль текущего пользователя (GET /api/auth/me)
public struct CurrentUserResponse: Codable, Sendable {
    public let user: User
}
