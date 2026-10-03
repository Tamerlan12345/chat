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

/// In-memory Keychain that can be pre-seeded with items written by older app versions.
final class SeededKeychainItemStore: KeychainItemStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private let failingDeletes: [String: OSStatus]

    init(failingDeletes: [String: OSStatus] = [:]) {
        self.failingDeletes = failingDeletes
    }

    func seed(_ account: String, _ value: String) {
        lock.lock()
        defer { lock.unlock() }
        values[account] = Data(value.utf8)
    }

    func string(_ account: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[account].flatMap { String(data: $0, encoding: .utf8) }
    }

    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        let account = Self.account(in: query)
        guard values[account] != nil else { return errSecItemNotFound }
        guard let data = attributes[kSecValueData as String] as? Data else { return errSecParam }
        values[account] = data
        return errSecSuccess
    }

    func add(attributes: [String: Any]) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        guard let data = attributes[kSecValueData as String] as? Data else { return errSecParam }
        values[Self.account(in: attributes)] = data
        return errSecSuccess
    }

    func read(query: [String: Any]) -> (status: OSStatus, data: Data?) {
        lock.lock()
        defer { lock.unlock() }
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
        return values.removeValue(forKey: account) == nil ? errSecItemNotFound : errSecSuccess
    }

    private static func account(in attributes: [String: Any]) -> String {
        attributes[kSecAttrAccount as String] as? String ?? ""
    }
}
