import Foundation
import Security

protocol KeychainItemStore: AnyObject {
    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus
    func add(attributes: [String: Any]) -> OSStatus
    func read(query: [String: Any]) -> (status: OSStatus, data: Data?)
    func delete(query: [String: Any]) -> OSStatus
}

private final class SecurityKeychainItemStore: KeychainItemStore {
    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func add(attributes: [String: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func read(query: [String: Any]) -> (status: OSStatus, data: Data?) {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result as? Data)
    }

    func delete(query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

public enum KeychainManagerError: Error, LocalizedError, Equatable, Sendable {
    case invalidValue
    case updateFailed(status: OSStatus)
    case addFailed(status: OSStatus)
    case deleteFailed(status: OSStatus)

    public var errorDescription: String? {
        switch self {
        case .invalidValue:
            return String(localized: "Защищённое хранилище получило недопустимое значение.")
        case .updateFailed, .addFailed:
            return String(localized: "Не удалось надёжно сохранить данные сессии на этом устройстве.")
        case .deleteFailed:
            return String(localized: "Не удалось надёжно удалить данные сессии с этого устройства.")
        }
    }
}

/// Outcome of binding stored credentials to the configured server.
public enum StoredCredentialDecision: Equatable, Sendable {
    case nothingStored
    /// The credentials were issued by this server and stay.
    case kept
    /// The credentials came from another (or an unknown) server and were deleted.
    case wiped
}

/// Менеджер безопасного хранилища Keychain для токенов и учетных данных устройства
public final class KeychainManager: @unchecked Sendable {
    public static let shared = KeychainManager(
        itemStore: SecurityKeychainItemStore(),
        serviceName: "kz.centras.centychat"
    )

    private let serviceName: String
    private let itemStore: KeychainItemStore
    private let lock = NSLock()

    private enum Keys {
        static let authToken = "auth_token"
        static let deviceId = "device_id"
        static let deviceSecret = "device_secret"
        /// Written by app versions that let the user type a server address. Never read as a server.
        static let legacyServerURL = "server_url"
        /// Origin of the server the stored token and device secret were issued for.
        static let credentialOrigin = "credential_origin"
        static let savedUsername = "saved_username"
    }

    private init(itemStore: KeychainItemStore, serviceName: String) {
        self.itemStore = itemStore
        self.serviceName = serviceName
    }

    internal convenience init(testStore: KeychainItemStore) {
        self.init(itemStore: testStore, serviceName: "kz.centras.centychat.tests")
    }

    // MARK: - Auth Token

    public var authToken: String? {
        value(forKey: Keys.authToken)
    }

    public func saveAuthToken(_ token: String) throws {
        try save(value: token, key: Keys.authToken)
    }

    // MARK: - Device ID

    public func deviceID() throws -> String {
        if let existing = value(forKey: Keys.deviceId) {
            return existing
        }

        let newID = UUID().uuidString
        try save(value: newID, key: Keys.deviceId)
        return newID
    }

    // MARK: - Device Secret

    public var deviceSecret: String? {
        value(forKey: Keys.deviceSecret)
    }

    public func saveDeviceSecret(_ secret: String) throws {
        try save(value: secret, key: Keys.deviceSecret)
    }

    // MARK: - Credential binding

    /// Makes sure the stored session and device secret belong to `origin`, the server this
    /// build is fixed to. Credentials issued for any other host (or for an unknown one) are
    /// wiped; the legacy user-entered server URL is removed. Throws when a wipe fails, in
    /// which case the stored credentials must not be used.
    public func bindCredentials(toOrigin origin: String) throws -> StoredCredentialDecision {
        let legacyServerURL = value(forKey: Keys.legacyServerURL)
        let boundOrigin = value(forKey: Keys.credentialOrigin)
        // Older installs recorded the issuer only as the user-entered server URL.
        let issuer = boundOrigin ?? legacyServerURL.flatMap(ServerEnvironment.origin(of:))
        let hasCredentials = authToken != nil || deviceSecret != nil

        let decision: StoredCredentialDecision
        if !hasCredentials {
            decision = .nothingStored
        } else if issuer == origin {
            decision = .kept
        } else {
            // Unknown or foreign issuer: never present these credentials to this server.
            try clearAllAuthData()
            decision = .wiped
        }

        if legacyServerURL != nil {
            try delete(key: Keys.legacyServerURL)
        }
        if boundOrigin != origin {
            try save(value: origin, key: Keys.credentialOrigin)
        }
        return decision
    }

    // MARK: - Saved Username

    public var savedUsername: String? {
        value(forKey: Keys.savedUsername)
    }

    public func saveUsername(_ username: String) throws {
        try save(value: username, key: Keys.savedUsername)
    }

    // MARK: - Clear All

    public func clearAllAuthData() throws {
        // Preserve the primary auth token if removing an auxiliary secret fails.
        // Callers must not report a successful logout until both deletes succeed.
        try delete(key: Keys.deviceSecret)
        try delete(key: Keys.authToken)
    }

#if DEBUG
    func resetForUITesting() throws {
        try delete(key: Keys.authToken)
        try delete(key: Keys.deviceId)
        try delete(key: Keys.deviceSecret)
        try delete(key: Keys.legacyServerURL)
        try delete(key: Keys.credentialOrigin)
        try delete(key: Keys.savedUsername)
    }
#endif

    // MARK: - Keychain Core Operations

    private func save(value: String, key: String) throws {
        guard !value.isEmpty, let data = value.data(using: .utf8) else {
            throw KeychainManagerError.invalidValue
        }

        lock.lock()
        defer { lock.unlock() }

        let query = baseQuery(for: key)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]

        let updateStatus = itemStore.update(query: query, attributes: attributes)
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var newItem = query
            newItem.merge(attributes) { _, new in new }
            let addStatus = itemStore.add(attributes: newItem)
            guard addStatus == errSecSuccess else {
                throw KeychainManagerError.addFailed(status: addStatus)
            }
        default:
            throw KeychainManagerError.updateFailed(status: updateStatus)
        }
    }

    private func value(forKey key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }

        var query = baseQuery(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        let result = itemStore.read(query: query)
        guard result.status == errSecSuccess, let data = result.data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private func delete(key: String) throws {
        lock.lock()
        defer { lock.unlock() }

        let status = itemStore.delete(query: baseQuery(for: key))
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainManagerError.deleteFailed(status: status)
        }
    }

    private func baseQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key
        ]
    }
}
