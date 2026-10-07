import Foundation
import Security
import XCTest
@testable import CentyChat

extension ServerEnvironment {
    /// The server every unit test talks to; never production.
    static let test = ServerEnvironment(validating: "https://chat.example.com")!
}

/// A one-shot latch for ordering concurrent test steps.
actor TestGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        guard !isOpen else { return }
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }
}

/// In-memory Keychain that can be pre-seeded with items written by older app versions. It keeps each
/// item's protection class, can refuse reads as a locked device does (`failingReads`), and can
/// refuse deletes of chosen items (`failingDeletes`).
final class SeededKeychainItemStore: KeychainItemStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private var classes: [String: String] = [:]
    private let failingDeletes: [String: OSStatus]
    private var readStatus: OSStatus?

    init(failingDeletes: [String: OSStatus] = [:]) {
        self.failingDeletes = failingDeletes
    }

    /// Every read answers `status` (e.g. `errSecInteractionNotAllowed` while the device is locked);
    /// nil — reads work.
    func failReads(with status: OSStatus?) {
        lock.lock()
        defer { lock.unlock() }
        readStatus = status
    }

    /// An item as an older app version wrote it, with its protection class.
    func seed(_ account: String, _ value: String, accessibleAs protection: String = kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String) {
        lock.lock()
        defer { lock.unlock() }
        values[account] = Data(value.utf8)
        classes[account] = protection
    }

    func string(_ account: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[account].flatMap { String(data: $0, encoding: .utf8) }
    }

    /// The protection class the item has now (`kSecAttrAccessible`).
    func protection(of account: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return classes[account]
    }

    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        if let readStatus { return readStatus }
        let account = Self.account(in: query)
        guard values[account] != nil else { return errSecItemNotFound }
        if let wanted = Self.protection(in: query), classes[account] != wanted { return errSecItemNotFound }
        let data = attributes[kSecValueData as String] as? Data
        let protection = Self.protection(in: attributes)
        guard data != nil || protection != nil else { return errSecParam }
        if let data { values[account] = data }
        if let protection { classes[account] = protection }
        return errSecSuccess
    }

    func add(attributes: [String: Any]) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        if let readStatus { return readStatus }
        guard let data = attributes[kSecValueData as String] as? Data else { return errSecParam }
        let account = Self.account(in: attributes)
        values[account] = data
        classes[account] = Self.protection(in: attributes)
        return errSecSuccess
    }

    func read(query: [String: Any]) -> (status: OSStatus, data: Data?) {
        lock.lock()
        defer { lock.unlock() }
        if let readStatus { return (readStatus, nil) }
        guard let data = values[Self.account(in: query)] else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, data)
    }

    func delete(query: [String: Any]) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        let account = Self.account(in: query)
        if let status = failingDeletes[account] {
            return status
        }
        classes[account] = nil
        return values.removeValue(forKey: account) == nil ? errSecItemNotFound : errSecSuccess
    }

    private static func account(in attributes: [String: Any]) -> String {
        attributes[kSecAttrAccount as String] as? String ?? ""
    }

    private static func protection(in attributes: [String: Any]) -> String? {
        attributes[kSecAttrAccessible as String] as? String
    }
}
