import Foundation

/// Онлайн-статус присутствия пользователя в CentyChat
public enum UserStatus: String, Codable, Sendable, CaseIterable {
    case online
    case away
    case dnd
    case offline
    
    public var displayName: String {
        switch self {
        case .online: return "В сети"
        case .away: return "Отошел"
        case .dnd: return "Не беспокоить"
        case .offline: return "Не в сети"
        }
    }
}

/// Набор прав учётной записи (Role Permissions)
public struct RolePermissions: Codable, Sendable, Equatable, Hashable {
    public var isAdmin: Bool
    public var isScopedAdmin: Bool
    public var canManageUsers: Bool
    public var canManageStructure: Bool
    public var canManageDb: Bool
    public var canBroadcast: Bool
    public var canCall: Bool
    public var canRemoteControl: Bool
    public var canCreateChannels: Bool
    public var canUploadFiles: Bool
    
    public init(
        isAdmin: Bool = false,
        isScopedAdmin: Bool = false,
        canManageUsers: Bool = false,
        canManageStructure: Bool = false,
        canManageDb: Bool = false,
        canBroadcast: Bool = false,
        canCall: Bool = true,
        canRemoteControl: Bool = false,
        canCreateChannels: Bool = true,
        canUploadFiles: Bool = true
    ) {
        self.isAdmin = isAdmin
        self.isScopedAdmin = isScopedAdmin
        self.canManageUsers = canManageUsers
        self.canManageStructure = canManageStructure
        self.canManageDb = canManageDb
        self.canBroadcast = canBroadcast
        self.canCall = canCall
        self.canRemoteControl = canRemoteControl
        self.canCreateChannels = canCreateChannels
        self.canUploadFiles = canUploadFiles
    }
    
    enum CodingKeys: String, CodingKey {
        case isAdmin = "is_admin"
        case isScopedAdmin = "is_scoped_admin"
        case canManageUsers = "can_manage_users"
        case canManageStructure = "can_manage_structure"
        case canManageDb = "can_manage_db"
        case canBroadcast = "can_broadcast"
        case canCall = "can_call"
        case canRemoteControl = "can_remote_control"
        case canCreateChannels = "can_create_channels"
        case canUploadFiles = "can_upload_files"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        isAdmin = try container.decodeIfPresent(Bool.self, forKey: .isAdmin) ?? false
        isScopedAdmin = try container.decodeIfPresent(Bool.self, forKey: .isScopedAdmin) ?? false
        canManageUsers = try container.decodeIfPresent(Bool.self, forKey: .canManageUsers) ?? false
        canManageStructure = try container.decodeIfPresent(Bool.self, forKey: .canManageStructure) ?? false
        canManageDb = try container.decodeIfPresent(Bool.self, forKey: .canManageDb) ?? false
        canBroadcast = try container.decodeIfPresent(Bool.self, forKey: .canBroadcast) ?? false
        canCall = try container.decodeIfPresent(Bool.self, forKey: .canCall) ?? false
        canRemoteControl = try container.decodeIfPresent(Bool.self, forKey: .canRemoteControl) ?? false
        canCreateChannels = try container.decodeIfPresent(Bool.self, forKey: .canCreateChannels) ?? false
        canUploadFiles = try container.decodeIfPresent(Bool.self, forKey: .canUploadFiles) ?? false
    }
}

/// Полная модель пользователя CentyChat
public struct User: Identifiable, Codable, Sendable, Equatable, Hashable {
    public let id: Int64
    public var username: String
    public var fullName: String
    public var email: String?
    public var phone: String?
    public var jobTitle: String?
    public var departmentId: Int64?
    public var departmentName: String?
    public var roleId: Int64?
    public var roleName: String?
    public var permissions: RolePermissions?
    public var uin: Int?
    public var `extension`: String?
    public var company: String?
    public var avatarUrl: String?
    public var status: UserStatus
    public var customStatus: String?
    public var lastSeen: Date?
    public var isActive: Bool
    public var mustChangePassword: Bool
    public var approvalStatus: String
    public var createdAt: Date
    public var tokenVersion: Int?
    
    public init(
        id: Int64,
        username: String,
        fullName: String,
        email: String? = nil,
        phone: String? = nil,
        jobTitle: String? = nil,
        departmentId: Int64? = nil,
        departmentName: String? = nil,
        roleId: Int64? = nil,
        roleName: String? = nil,
        permissions: RolePermissions? = nil,
        uin: Int? = nil,
        extension: String? = nil,
        company: String? = nil,
        avatarUrl: String? = nil,
        status: UserStatus = .offline,
        customStatus: String? = nil,
        lastSeen: Date? = nil,
        isActive: Bool = true,
        mustChangePassword: Bool = false,
        approvalStatus: String = "approved",
        createdAt: Date = Date(),
        tokenVersion: Int? = nil
    ) {
        self.id = id
        self.username = username
        self.fullName = fullName
        self.email = email
        self.phone = phone
        self.jobTitle = jobTitle
        self.departmentId = departmentId
        self.departmentName = departmentName
        self.roleId = roleId
        self.roleName = roleName
        self.permissions = permissions
        self.uin = uin
        self.extension = `extension`
        self.company = company
        self.avatarUrl = avatarUrl
        self.status = status
        self.customStatus = customStatus
        self.lastSeen = lastSeen
        self.isActive = isActive
        self.mustChangePassword = mustChangePassword
        self.approvalStatus = approvalStatus
        self.createdAt = createdAt
        self.tokenVersion = tokenVersion
    }
    
    enum CodingKeys: String, CodingKey {
        case id
        case username
        case fullName = "full_name"
        case email
        case phone
        case jobTitle = "job_title"
        case departmentId = "department_id"
        case departmentName = "department_name"
        case roleId = "role_id"
        case roleName = "role_name"
        case permissions
        case uin
        case `extension`
        case company
        case avatarUrl = "avatar_url"
        case status
        case customStatus = "custom_status"
        case lastSeen = "last_seen"
        case isActive = "is_active"
        case mustChangePassword = "must_change_password"
        case approvalStatus = "approval_status"
        case createdAt = "created_at"
        case tokenVersion = "token_version"
    }
    
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(Int64.self, forKey: .id)
        self.username = try container.decode(String.self, forKey: .username)
        self.fullName = try container.decode(String.self, forKey: .fullName)
        self.email = try container.decodeIfPresent(String.self, forKey: .email)
        self.phone = try container.decodeIfPresent(String.self, forKey: .phone)
        self.jobTitle = try container.decodeIfPresent(String.self, forKey: .jobTitle)
        self.departmentId = try container.decodeIfPresent(Int64.self, forKey: .departmentId)
        self.departmentName = try container.decodeIfPresent(String.self, forKey: .departmentName)
        self.roleId = try container.decodeIfPresent(Int64.self, forKey: .roleId)
        self.roleName = try container.decodeIfPresent(String.self, forKey: .roleName)
        self.permissions = try container.decodeIfPresent(RolePermissions.self, forKey: .permissions)
        self.uin = try container.decodeIfPresent(Int.self, forKey: .uin)
        self.extension = try container.decodeIfPresent(String.self, forKey: .extension)
        self.company = try container.decodeIfPresent(String.self, forKey: .company)
        self.avatarUrl = try container.decodeIfPresent(String.self, forKey: .avatarUrl)
        self.status = try container.decodeIfPresent(UserStatus.self, forKey: .status) ?? .offline
        self.customStatus = try container.decodeIfPresent(String.self, forKey: .customStatus)
        
        if let lastSeenString = try container.decodeIfPresent(String.self, forKey: .lastSeen) {
            self.lastSeen = DateParser.parse(lastSeenString)
        } else {
            self.lastSeen = nil
        }
        
        if let activeInt = try? container.decode(Int.self, forKey: .isActive) {
            self.isActive = (activeInt != 0)
        } else if let activeBool = try? container.decode(Bool.self, forKey: .isActive) {
            self.isActive = activeBool
        } else {
            self.isActive = true
        }
        
        if let mcpInt = try? container.decode(Int.self, forKey: .mustChangePassword) {
            self.mustChangePassword = (mcpInt != 0)
        } else if let mcpBool = try? container.decode(Bool.self, forKey: .mustChangePassword) {
            self.mustChangePassword = mcpBool
        } else {
            self.mustChangePassword = false
        }
        
        self.approvalStatus = try container.decodeIfPresent(String.self, forKey: .approvalStatus) ?? "approved"
        
        if let createdString = try container.decodeIfPresent(String.self, forKey: .createdAt) {
            self.createdAt = DateParser.parse(createdString) ?? Date()
        } else {
            self.createdAt = Date()
        }
        
        self.tokenVersion = try container.decodeIfPresent(Int.self, forKey: .tokenVersion)
    }
    
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(username, forKey: .username)
        try container.encode(fullName, forKey: .fullName)
        try container.encodeIfPresent(email, forKey: .email)
        try container.encodeIfPresent(phone, forKey: .phone)
        try container.encodeIfPresent(jobTitle, forKey: .jobTitle)
        try container.encodeIfPresent(departmentId, forKey: .departmentId)
        try container.encodeIfPresent(departmentName, forKey: .departmentName)
        try container.encodeIfPresent(roleId, forKey: .roleId)
        try container.encodeIfPresent(roleName, forKey: .roleName)
        try container.encodeIfPresent(permissions, forKey: .permissions)
        try container.encodeIfPresent(uin, forKey: .uin)
        try container.encodeIfPresent(`extension`, forKey: .extension)
        try container.encodeIfPresent(company, forKey: .company)
        try container.encodeIfPresent(avatarUrl, forKey: .avatarUrl)
        try container.encode(status, forKey: .status)
        try container.encodeIfPresent(customStatus, forKey: .customStatus)
        if let lastSeen = lastSeen {
            try container.encode(DateParser.format(lastSeen), forKey: .lastSeen)
        }
        try container.encode(isActive ? 1 : 0, forKey: .isActive)
        try container.encode(mustChangePassword ? 1 : 0, forKey: .mustChangePassword)
        try container.encode(approvalStatus, forKey: .approvalStatus)
        try container.encode(DateParser.format(createdAt), forKey: .createdAt)
        try container.encodeIfPresent(tokenVersion, forKey: .tokenVersion)
    }
}

/// Публичная карточка коллеги в телефонной книге
public struct PublicUser: Identifiable, Codable, Sendable, Equatable, Hashable {
    public let id: Int64
    public var username: String
    public var fullName: String
    public var email: String?
    public var phone: String?
    public var jobTitle: String?
    public var departmentId: Int64?
    public var departmentName: String?
    public var roleId: Int64?
    public var roleName: String?
    public var uin: Int?
    public var `extension`: String?
    public var company: String?
    public var avatarUrl: String?
    public var status: UserStatus
    public var customStatus: String?
    public var lastSeen: Date?
    public var isActive: Bool
    public var createdAt: Date
    
    public init(
        id: Int64,
        username: String,
        fullName: String,
        email: String? = nil,
        phone: String? = nil,
        jobTitle: String? = nil,
        departmentId: Int64? = nil,
        departmentName: String? = nil,
        roleId: Int64? = nil,
        roleName: String? = nil,
        uin: Int? = nil,
        extension: String? = nil,
        company: String? = nil,
        avatarUrl: String? = nil,
        status: UserStatus = .offline,
        customStatus: String? = nil,
        lastSeen: Date? = nil,
        isActive: Bool = true,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.username = username
        self.fullName = fullName
        self.email = email
        self.phone = phone
        self.jobTitle = jobTitle
        self.departmentId = departmentId
        self.departmentName = departmentName
        self.roleId = roleId
        self.roleName = roleName
        self.uin = uin
        self.extension = `extension`
        self.company = company
        self.avatarUrl = avatarUrl
        self.status = status
        self.customStatus = customStatus
        self.lastSeen = lastSeen
        self.isActive = isActive
        self.createdAt = createdAt
    }
    
    enum CodingKeys: String, CodingKey {
        case id
        case username
        case fullName = "full_name"
        case email
        case phone
        case jobTitle = "job_title"
        case departmentId = "department_id"
        case departmentName = "department_name"
        case roleId = "role_id"
        case roleName = "role_name"
        case uin
        case `extension`
        case company
        case avatarUrl = "avatar_url"
        case status
        case customStatus = "custom_status"
        case lastSeen = "last_seen"
        case isActive = "is_active"
        case createdAt = "created_at"
    }
    
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(Int64.self, forKey: .id)
        self.username = try container.decode(String.self, forKey: .username)
        self.fullName = try container.decode(String.self, forKey: .fullName)
        self.email = try container.decodeIfPresent(String.self, forKey: .email)
        self.phone = try container.decodeIfPresent(String.self, forKey: .phone)
        self.jobTitle = try container.decodeIfPresent(String.self, forKey: .jobTitle)
        self.departmentId = try container.decodeIfPresent(Int64.self, forKey: .departmentId)
        self.departmentName = try container.decodeIfPresent(String.self, forKey: .departmentName)
        self.roleId = try container.decodeIfPresent(Int64.self, forKey: .roleId)
        self.roleName = try container.decodeIfPresent(String.self, forKey: .roleName)
        self.uin = try container.decodeIfPresent(Int.self, forKey: .uin)
        self.extension = try container.decodeIfPresent(String.self, forKey: .extension)
        self.company = try container.decodeIfPresent(String.self, forKey: .company)
        self.avatarUrl = try container.decodeIfPresent(String.self, forKey: .avatarUrl)
        self.status = try container.decodeIfPresent(UserStatus.self, forKey: .status) ?? .offline
        self.customStatus = try container.decodeIfPresent(String.self, forKey: .customStatus)
        
        if let lastSeenString = try container.decodeIfPresent(String.self, forKey: .lastSeen) {
            self.lastSeen = DateParser.parse(lastSeenString)
        } else {
            self.lastSeen = nil
        }
        
        if let activeInt = try? container.decode(Int.self, forKey: .isActive) {
            self.isActive = (activeInt != 0)
        } else if let activeBool = try? container.decode(Bool.self, forKey: .isActive) {
            self.isActive = activeBool
        } else {
            self.isActive = true
        }
        
        if let createdString = try container.decodeIfPresent(String.self, forKey: .createdAt) {
            self.createdAt = DateParser.parse(createdString) ?? Date()
        } else {
            self.createdAt = Date()
        }
    }
}
