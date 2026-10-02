import Foundation
import UIKit
import UserNotifications

/// Where pushes and notification callbacks reach the running app's stores.
@MainActor
final class PushRouter {
    static let shared = PushRouter()
    weak var notifications: MessageNotificationsStore?
}

/// Silent pushes (`read`, `content-available`) — `multi-device.md` §10: dismiss the
/// conversation's notifications and zero its unread counter; nothing is shown.
final class CentyAppDelegate: NSObject, UIApplicationDelegate {
    private let notificationDelegate = NotificationPresentationDelegate()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = notificationDelegate
        return true
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let payload = PushPayload.parse(userInfo), let store = PushRouter.shared.notifications else {
            completionHandler(.noData)
            return
        }
        store.handleRemotePush(payload)
        Task {
            await store.drain()
            completionHandler(.newData)
        }
    }
}

/// Decides what a notification arriving while the app is open shows.
final class NotificationPresentationDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let payload = PushPayload.parse(notification.request.content.userInfo)
        let isLocal = !(notification.request.trigger is UNPushNotificationTrigger)
        let show = await MainActor.run {
            PushRouter.shared.notifications?.shouldPresentInForeground(payload, isLocal: isLocal) ?? isLocal
        }
        return show ? [.banner, .list, .sound] : []
    }
}
