import Foundation
import Security

/// Менеджер безопасного хранилища Keychain для токенов и учетных данных устройства
public final class KeychainManager: @unchecked Sendable {
    public static let shared = KeychainManager()
    
    private let serviceName = "kz.centras.centychat"
    private let lock = NSLock()
    
    private enum Keys {
        static let authToken = "auth_token"
        static let deviceId = "device_id"
        static let deviceSecret = "device_secret"
        static let serverUrl = "server_url"
        static let savedUsername = "saved_username"
    }
    
    private init() {}
    
    // MARK: - Auth Token
    
    public var authToken: String? {
        get { get(key: Keys.authToken) }
        set {
            if let value = newValue {
                set(value: value, key: Keys.authToken)
            } else {
                delete(key: Keys.authToken)
            }
        }
    }
    
    // MARK: - Device ID
    
    public var deviceId: String {
        get {
            if let existing = get(key: Keys.deviceId) {
                return existing
            }
            let newId = UUID().uuidString
            set(value: newId, key: Keys.deviceId)
            return newId
        }
        set {
            set(value: newValue, key: Keys.deviceId)
        }
    }
    
    // MARK: - Device Secret
    
    public var deviceSecret: String? {
        get { get(key: Keys.deviceSecret) }
        set {
            if let value = newValue {
                set(value: value, key: Keys.deviceSecret)
            } else {
                delete(key: Keys.deviceSecret)
            }
        }
    }
    
    // MARK: - Server URL
    
    public var serverUrl: String {
        get {
            get(key: Keys.serverUrl) ?? "http://localhost:2004"
        }
        set {
            set(value: newValue, key: Keys.serverUrl)
        }
    }
    
    // MARK: - Saved Username
    
    public var savedUsername: String? {
        get { get(key: Keys.savedUsername) }
        set {
            if let value = newValue {
                set(value: value, key: Keys.savedUsername)
            } else {
                delete(key: Keys.savedUsername)
            }
        }
    }
    
    // MARK: - Clear All
    
    public func clearAllAuthData() {
        authToken = nil
        deviceSecret = nil
    }
    
    // MARK: - Keychain Core Operations
    
    private func set(value: String, key: String) {
        lock.lock()
        defer { lock.unlock() }
        
        guard let data = value.data(using: .utf8) else { return }
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key
        ]
        
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var newItem = query
            newItem.merge(attributes) { (_, new) in new }
            SecItemAdd(newItem as CFDictionary, nil)
        }
    }
    
    private func get(key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        
        var dataTypeRef: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &dataTypeRef)
        
        guard status == errSecSuccess, let data = dataTypeRef as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
    
    private func delete(key: String) {
        lock.lock()
        defer { lock.unlock() }
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
    }
}
