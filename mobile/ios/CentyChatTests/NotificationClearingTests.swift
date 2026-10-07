import Foundation
import XCTest
@testable import CentyChat

/// When a session ends (sign-out, a refused session, a deleted account, another account), the
/// notifications it left on the lock screen go with it (parity P10, Android's lane M3): nobody sees
/// the previous account's messages, and a tap cannot open a chat of an account that is gone.
@MainActor
final class NotificationClearingTests: XCTestCase {
    func testTheEndOfASessionRemovesItsDeliveredNotifications() async {
        let app = TestApp()
        let center = RecordingNotificationCenter()
        let store = MessageNotificationsStore(
            center: center,
            session: app.session,
            conversations: app.container.conversations,
            presence: app.container.presence
        )

        store.reset()
        await store.drain()

        XCTAssertEqual(center.removedAll, 1)
    }
}

/// Records what the notification centre was asked to do.
final class RecordingNotificationCenter: LocalNotificationCenter, @unchecked Sendable {
    private let count = Locked(0)

    var removedAll: Int { count.value }

    func post(_ alert: MessageAlert) async {}
    func removeDelivered(threadIdentifier: String) async {}
    func removeDelivered(identifier: String) async {}

    func removeAllDelivered() async {
        count.withValue { $0 += 1 }
    }
}
