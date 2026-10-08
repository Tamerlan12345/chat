import Foundation
import Security
import XCTest
@testable import CentyChat

/// A locked device is not a signed-out device (final review I1). The session lives in the Keychain
/// with `AfterFirstUnlockThisDeviceOnly`, so a call kept running behind the lock screen can still
/// read it; and when an item cannot be read at all (before the first unlock), that is "unavailable
/// for now", never "absent": nothing is cleared and nothing signs the user out.
final class KeychainAvailabilityTests: XCTestCase {
    private let afterFirstUnlock = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
    private let whenUnlocked = kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String

    func testNewItemsStayReadableWhileTheDeviceIsLocked() throws {
        let store = SeededKeychainItemStore()
        let keychain = KeychainManager(testStore: store)

        try keychain.saveAuthToken("token")
        try keychain.saveDeviceSecret("secret")
        _ = try keychain.deviceID()

        for item in ["auth_token", "device_secret", "device_id"] {
            XCTAssertEqual(store.protection(of: item), afterFirstUnlock, item)
        }
    }

    func testItemsOfOlderVersionsMoveToTheAfterFirstUnlockClassAtLaunch() {
        let store = SeededKeychainItemStore()
        store.seed("auth_token", "token", accessibleAs: whenUnlocked)
        store.seed("device_secret", "secret", accessibleAs: whenUnlocked)
        store.seed("device_id", "device-1", accessibleAs: whenUnlocked)
        let keychain = KeychainManager(testStore: store)

        keychain.upgradeItemProtection()

        XCTAssertEqual(store.protection(of: "auth_token"), afterFirstUnlock)
        XCTAssertEqual(store.protection(of: "device_secret"), afterFirstUnlock)
        XCTAssertEqual(store.protection(of: "device_id"), afterFirstUnlock)
        XCTAssertEqual(keychain.authToken, "token", "the value itself is untouched")
    }

    func testAnUnreadableTokenIsUnavailableNotAbsent() {
        let store = SeededKeychainItemStore()
        store.seed("auth_token", "token")
        store.failReads(with: errSecInteractionNotAllowed)
        let keychain = KeychainManager(testStore: store)

        XCTAssertThrowsError(try keychain.storedAuthToken()) { error in
            XCTAssertEqual(error as? KeychainManagerError, .unavailable(status: errSecInteractionNotAllowed))
        }
        XCTAssertFalse(keychain.canReadStoredItems)

        store.failReads(with: nil)
        XCTAssertEqual(try keychain.storedAuthToken(), "token")
        XCTAssertTrue(keychain.canReadStoredItems)
    }

    func testAnUnreadableDeviceIdIsNeverReplacedByANewOne() {
        let store = SeededKeychainItemStore()
        store.seed("device_id", "device-1")
        store.failReads(with: errSecInteractionNotAllowed)
        let keychain = KeychainManager(testStore: store)

        XCTAssertThrowsError(try keychain.deviceID())

        store.failReads(with: nil)
        XCTAssertEqual(try keychain.deviceID(), "device-1", "the device keeps its identity")
    }

    func testBindingUnreadableCredentialsThrowsUnavailableAndWipesNothing() {
        let store = SeededKeychainItemStore()
        store.seed("auth_token", "token")
        store.seed("credential_origin", ServerEnvironment.test.origin)
        store.failReads(with: errSecInteractionNotAllowed)
        let keychain = KeychainManager(testStore: store)

        XCTAssertThrowsError(try keychain.bindCredentials(toOrigin: ServerEnvironment.test.origin)) { error in
            XCTAssertEqual(error as? KeychainManagerError, .unavailable(status: errSecInteractionNotAllowed))
        }
        XCTAssertEqual(store.string("auth_token"), "token")
    }

    func testTheUserSnapshotIsKeptForAnOfflineLaunchAndGoesWithTheSession() throws {
        let keychain = KeychainManager(testStore: SeededKeychainItemStore())
        let user = User(id: 7, username: "ivan", fullName: "Иван Иванов", email: "ivan@example.com", createdAt: Date(timeIntervalSince1970: 1_700_000_000))

        try keychain.saveUserSnapshot(user)
        XCTAssertEqual(try keychain.storedUserSnapshot(), user)

        try keychain.clearAllAuthData()
        XCTAssertNil(try keychain.storedUserSnapshot(), "signing out forgets who was signed in")
    }

    // MARK: - Requests while the token cannot be read

    func testARequestWithAnUnreadableTokenIsAConnectionProblemAndClearsNothing() async {
        let store = SeededKeychainItemStore()
        store.seed("auth_token", "token")
        store.failReads(with: errSecInteractionNotAllowed)
        let keychain = KeychainManager(testStore: store)
        RecordingURLProtocol.reset()
        let client = APIClient(session: RecordingURLProtocol.session(), keychain: keychain, environment: .test)

        do {
            _ = try await client.getCurrentUser()
            XCTFail("nothing can be asked without the token")
        } catch APIError.noConnection {
            // A wait, like no network: the session is kept and asked again later.
        } catch {
            XCTFail("a locked Keychain is not a rejected session: \(error)")
        }
        XCTAssertTrue(RecordingURLProtocol.requests.isEmpty, "no request without a token")
        store.failReads(with: nil)
        XCTAssertEqual(keychain.authToken, "token", "the session stays")
    }

    func testARawRequestWithAnUnreadableTokenIsUnreachable() async {
        let store = SeededKeychainItemStore()
        store.seed("auth_token", "token")
        store.failReads(with: errSecInteractionNotAllowed)
        let keychain = KeychainManager(testStore: store)
        RecordingURLProtocol.reset()
        let client = APIClient(session: RecordingURLProtocol.session(), keychain: keychain, environment: .test)

        let response = await client.raw(method: "POST", endpoint: "/messages", body: Data("{}".utf8))

        XCTAssertEqual(response.status, 0, "the delivery engine waits; a 401 would spend the session")
    }
}
