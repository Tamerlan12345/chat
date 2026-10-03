import Foundation
import Observation

/// Banners / local notifications about messages and their dismissal across devices
/// (`multi-device.md` §5, §6, §8):
/// - a message frame shows a notification only when `notify == true` (no field — the local rule);
/// - `conversation_read` and the silent push `read` remove the conversation's delivered
///   notifications (`thread-id` `<conversationType>-<targetId>`) and zero its unread counter;
/// - a deleted message's notification is removed.
@Observable
@MainActor
public final class MessageNotificationsStore: RealtimeEventHandling {
    @ObservationIgnored private let center: any LocalNotificationCenter
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private let conversations: ConversationsStore
    @ObservationIgnored private let presence: PresenceController
    /// Messages this device already has, so a late push about them is not shown.
    @ObservationIgnored private var knownMessageIDs = RecentIDs(capacity: 1_024)
    /// Notification work runs in order (post, then a dismissal that follows it).
    @ObservationIgnored private var queue: Task<Void, Never>?

    init(
        center: any LocalNotificationCenter,
        session: SessionStore,
        conversations: ConversationsStore,
        presence: PresenceController
    ) {
        self.center = center
        self.session = session
        self.conversations = conversations
        self.presence = presence
    }

    // MARK: - Realtime

    func handle(_ event: WSServerEvent) {
        switch event {
        case .newMessage(let message, let notify):
            _ = knownMessageIDs.insert(message.id)
            let currentUserId = session.currentUser?.id
            guard MessageAlertPolicy.shouldAlert(
                message: message,
                notify: notify,
                currentUserId: currentUserId,
                visibleConversation: conversations.visibleConversation,
                isDndEnabled: presence.isDndEnabled
            ) else { return }
            let alert = MessageAlert(
                conversation: MessageAlertPolicy.conversation(of: message, currentUserId: currentUserId),
                messageId: message.id,
                title: message.senderName,
                body: Self.body(of: message)
            )
            enqueue { center in await center.post(alert) }

        case .conversationRead(let conversation, _, _, _):
            dismiss(conversation)

        case .messageDeleted(let messageId, _, _):
            let identifier = MessageAlertPolicy.identifier(forMessage: messageId)
            enqueue { center in await center.removeDelivered(identifier: identifier) }

        default:
            break
        }
    }

    // MARK: - Push

    /// A push delivered to the app (`didReceiveRemoteNotification` or while in the foreground).
    /// `read` dismisses and zeroes the conversation; nothing is ever shown for it.
    public func handleRemotePush(_ payload: PushPayload) {
        switch payload {
        case .read(let conversation):
            conversations.markConversationRead(conversation)
            dismiss(conversation)
        case .message, .call:
            break
        }
    }

    /// Whether a notification arriving while the app is open is shown. Local alerts were decided
    /// when they were posted; a message push is hidden when the message is known or its chat is open.
    public func shouldPresentInForeground(_ payload: PushPayload?, isLocal: Bool) -> Bool {
        if isLocal { return true }
        guard case .message(let conversation, let messageId)? = payload else { return false }
        return MessageAlertPolicy.shouldPresentMessagePush(
            conversation: conversation,
            messageId: messageId,
            isKnownMessage: knownMessageIDs.contains(messageId),
            visibleConversation: conversations.visibleConversation
        )
    }

    func reset() {
        knownMessageIDs.removeAll()
    }

    /// Waits for queued notification work (tests).
    func drain() async {
        await queue?.value
    }

    // MARK: - Private

    private func dismiss(_ conversation: ConversationKey) {
        let thread = MessageAlertPolicy.threadIdentifier(for: conversation)
        enqueue { center in await center.removeDelivered(threadIdentifier: thread) }
    }

    private func enqueue(_ work: @escaping @Sendable (any LocalNotificationCenter) async -> Void) {
        let previous = queue
        let center = self.center
        queue = Task {
            await previous?.value
            await work(center)
        }
    }

    private static func body(of message: Message) -> String {
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch message.type {
        case .text where !text.isEmpty:
            return text
        default:
            return String(localized: "Новое сообщение")
        }
    }
}
