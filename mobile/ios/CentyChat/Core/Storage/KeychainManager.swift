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
    /// The item exists but cannot be read now (the device was not unlocked since it started).
    case unavailable(status: OSStatus)

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            return AppCopy.regStorage
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
        /// The signed-in user (JSON), so a launch without the server keeps the session.
        static let userSnapshot = "user_snapshot"

        static let all = [authToken, deviceId, deviceSecret, legacyServerURL, credentialOrigin, savedUsername, userSnapshot]
    }

    /// The protection class of every item: readable after the first unlock since boot, so a call
    /// running behind the lock screen (or a background flush) still has its session; never synced or
    /// restored to another device (final review I1).
    static var protection: String { kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String }

    private init(itemStore: KeychainItemStore, serviceName: String) {
        self.itemStore = itemStore
        self.serviceName = serviceName
    }

    internal convenience init(testStore: KeychainItemStore) {
        self.init(itemStore: testStore, serviceName: "kz.centras.centychat.tests")
    }

    // MARK: - Auth Token

    /// The stored token, or nil both when there is none and when it cannot be read now. Callers that
    /// must tell the two apart (a missing token ends nothing; an unreadable one must not either) use
    /// `storedAuthToken()`.
    public var authToken: String? {
        value(forKey: Keys.authToken)
    }

    /// The stored token; nil — none. Throws `unavailable` when it exists but cannot be read now
    /// (the device has not been unlocked since it started): a wait, never a signed-out session.
    public func storedAuthToken() throws -> String? {
        try read(forKey: Keys.authToken)
    }

    /// Whether stored items can be read now.
    public var canReadStoredItems: Bool {
        do {
            _ = try read(forKey: Keys.authToken)
            return true
        } catch {
            return false
        }
    }

    /// Items written by older versions (`WhenUnlockedThisDeviceOnly`) move to `protection`; values
    /// stay as they are. Called once per launch; items already moved are not touched.
    public func upgradeItemProtection() {
        lock.lock()
        defer { lock.unlock() }
        for key in Keys.all {
            var query = baseQuery(for: key)
            query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let status = itemStore.update(query: query, attributes: [kSecAttrAccessible as String: Self.protection])
            if status != errSecSuccess && status != errSecItemNotFound {
                Log.session.notice("Keychain item protection not upgraded (status \(status, privacy: .public))")
            }
        }
    }

    /// The signed-in user, kept for a launch without the server (final review I2).
    public func saveUserSnapshot(_ user: User) throws {
        let data = try JSONEncoder().encode(user)
        guard let json = String(data: data, encoding: .utf8) else { throw KeychainManagerError.invalidValue }
        try save(value: json, key: Keys.userSnapshot)
    }

    /// The kept user; nil — none (or one this version cannot read). Throws `unavailable` like the token.
    public func storedUserSnapshot() throws -> User? {
        guard let json = try read(forKey: Keys.userSnapshot) else { return nil }
        return try? JSONDecoder().decode(User.self, from: Data(json.utf8))
    }

    public func saveAuthToken(_ token: String) throws {
        try save(value: token, key: Keys.authToken)
    }

    // MARK: - Device ID

    /// This device's identifier. An identifier that exists but cannot be read now is never replaced
    /// by a new one (that would make the server see another device): it throws `unavailable`.
    public func deviceID() throws -> String {
        if let existing = try read(forKey: Keys.deviceId) {
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
        // Unreadable items (a locked device) throw `unavailable`: nothing is decided or wiped then.
        let legacyServerURL = try read(forKey: Keys.legacyServerURL)
        let boundOrigin = try read(forKey: Keys.credentialOrigin)
        // Older installs recorded the issuer only as the user-entered server URL.
        let issuer = boundOrigin ?? legacyServerURL.flatMap(ServerEnvironment.origin(of:))
        let hasCredentials = try read(forKey: Keys.authToken) != nil || read(forKey: Keys.deviceSecret) != nil

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
        // Who was signed in goes with the session; a leftover is harmless (it is used only with a token).
        do {
            try delete(key: Keys.userSnapshot)
        } catch {
            Log.session.notice("The signed-in user snapshot could not be deleted")
        }
    }

    /// Account deletion: the session, the device secret and the remembered login name.
    public func clearAllUserData() throws {
        try clearAllAuthData()
        try delete(key: Keys.savedUsername)
    }

#if DEBUG
    func resetForUITesting() throws {
        try delete(key: Keys.authToken)
        try delete(key: Keys.deviceId)
        try delete(key: Keys.deviceSecret)
        try delete(key: Keys.legacyServerURL)
        try delete(key: Keys.credentialOrigin)
        try delete(key: Keys.savedUsername)
        try delete(key: Keys.userSnapshot)
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
            kSecAttrAccessible as String: Self.protection
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

    /// nil both for a missing and for an unreadable item (callers that may not mix them up use `read`).
    private func value(forKey key: String) -> String? {
        (try? read(forKey: key)) ?? nil
    }

    /// The item's value; nil — no such item. Any other failure (`errSecInteractionNotAllowed` while
    /// the device is locked before its first unlock, …) throws `unavailable`: the item may well exist.
    private func read(forKey key: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }

        var query = baseQuery(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        let result = itemStore.read(query: query)
        switch result.status {
        case errSecSuccess:
            return result.data.flatMap { String(data: $0, encoding: .utf8) }
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainManagerError.unavailable(status: result.status)
        }
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
