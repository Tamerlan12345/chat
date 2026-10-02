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
        static let serverUrl = "server_url"
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

    // MARK: - Server URL

    public var serverUrl: String {
        guard let storedURL = value(forKey: Keys.serverUrl),
              let secureURL = ServerEndpointPolicy.configuredURL(from: storedURL) else {
            return ""
        }
        return secureURL.absoluteString
    }

    public func saveServerURL(_ value: String) throws {
        guard let secureURL = ServerEndpointPolicy.configuredURL(from: value) else {
            try delete(key: Keys.serverUrl)
            return
        }
        try save(value: secureURL.absoluteString, key: Keys.serverUrl)
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
        try delete(key: Keys.serverUrl)
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
