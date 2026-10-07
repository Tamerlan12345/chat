import Foundation
import UIKit
import UserNotifications

/// Where pushes and notification callbacks reach the running app's stores.
@MainActor
final class PushRouter {
    static let shared = PushRouter()
    weak var notifications: MessageNotificationsStore?
    weak var pushTokens: PushTokenRegistrar?
    /// Where a tapped message notification's chat waits for the chat list.
    weak var routes: NotificationRoutes?
    /// Who is signed in, for a tapped notification (nil while the stored session is restored).
    weak var session: SessionStore?
    /// The outbox flush a background refresh runs (`DeliveryBackgroundTask`).
    var flushInBackground: (@MainActor () async -> DeliveryRuntime.FlushResult)?
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
#if DEBUG
        if LaunchTestFixture.isUnitTestHost { return true }
#endif
        // The background flush of the outbox: registered before launch ends, as iOS requires.
        DeliveryBackgroundTask.register()
        // Inert until the app is signed with an Apple developer account (decision P): without the
        // `aps-environment` entitlement APNs answers with the failure callback below and push stays
        // off. With it, a token arrives here even before the user answers the permission question.
        application.registerForRemoteNotifications()
        return true
    }

    /// A new (or the same) APNs token: registered with the server for the signed-in session (`push.md` §2).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard let registrar = PushRouter.shared.pushTokens else { return }
        Task { await registrar.deviceTokenChanged(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        Log.session.notice("APNs registration unavailable: \(error.localizedDescription, privacy: .public)")
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

    /// A tap on a notification (decision P): a message notification opens its chat. The payload
    /// carries ids only; the chat list opens the chat and loads its content from the server.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let conversation = NotificationTap.conversation(from: response.notification.request.content.userInfo) else { return }
        await MainActor.run {
            let router = PushRouter.shared
            // Signed out: a tap opens nothing (nobody's chat to show). While the stored session is
            // restored, the tap belongs to that session.
            guard let session = router.session, session.phase != .signedOut else { return }
            router.routes?.open(conversation, account: session.currentUser?.id)
        }
    }
}
