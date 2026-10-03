import Foundation
import Observation

/// Direct conversations, channels, the colleague directory and typing indicators.
@Observable
@MainActor
public final class ConversationsStore: RealtimeEventHandling {
    public var directConversations: [DirectConversation] = []
    public var channels: [Channel] = []
    public var users: [PublicUser] = []
    /// "\(conversationType)_\(targetId)" → «Алия печатает...»
    public private(set) var typingUsers: [String: String] = [:]
    public private(set) var directState: LoadState = .idle
    public private(set) var channelsState: LoadState = .idle
    public private(set) var usersState: LoadState = .idle

    @ObservationIgnored private let repository: any ChatRepository
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private var typingResetTimers: [String: Task<Void, Never>] = [:]
    /// The conversation whose chat screen is on screen; it never accumulates unread messages.
    @ObservationIgnored private(set) var visibleConversation: ConversationKey?

    init(repository: any ChatRepository, session: SessionStore) {
        self.repository = repository
        self.session = session
    }

    public var totalDirectUnread: Int {
        directConversations.reduce(0) { $0 + $1.unreadCount }
    }

    public var totalChannelUnread: Int {
        channels.reduce(0) { $0 + $1.unreadCount }
    }

    public static func typingKey(for conversation: ConversationKey) -> String {
        "\(conversation.type.rawValue)_\(conversation.targetId)"
    }

    // MARK: - Loading (each list independently)

    public func loadDirectConversations() async {
        directState = .loading
        do {
            directConversations = try await repository.directConversations()
            directState = .loaded
        } catch {
            Log.chat.error("Loading dialogs failed: \(error.localizedDescription, privacy: .public)")
            directState = .failed(error.userMessage)
        }
    }

    public func loadChannels() async {
        channelsState = .loading
        do {
            channels = try await repository.channels()
            channelsState = .loaded
        } catch {
            Log.chat.error("Loading channels failed: \(error.localizedDescription, privacy: .public)")
            channelsState = .failed(error.userMessage)
        }
    }

    public func loadUsers() async {
        usersState = .loading
        do {
            users = try await repository.users()
            usersState = .loaded
        } catch {
            Log.chat.error("Loading colleagues failed: \(error.localizedDescription, privacy: .public)")
            usersState = .failed(error.userMessage)
        }
    }

    // MARK: - Mutations

    func setConversation(_ conversation: ConversationKey, visible: Bool) {
        if visible {
            visibleConversation = conversation
        } else if visibleConversation == conversation {
            visibleConversation = nil
        }
    }

    func markConversationRead(_ conversation: ConversationKey) {
        switch conversation.type {
        case .direct:
            if let index = directConversations.firstIndex(where: { $0.userId == conversation.targetId }) {
                directConversations[index].unreadCount = 0
            }
        case .channel:
            if let index = channels.firstIndex(where: { $0.id == conversation.targetId }) {
                channels[index].unreadCount = 0
            }
        }
    }

    public func createChannel(name rawName: String, topic: String, isPrivate: Bool) async throws {
        var name = rawName.trimmingCharacters(in: .whitespaces)
        if !name.hasPrefix("#") {
            name = "#" + name
        }
        let created = try await repository.createChannel(
            name: name,
            topic: topic.isEmpty ? nil : topic,
            type: isPrivate ? .private : .public
        )
        if !channels.contains(where: { $0.id == created.id }) {
            channels.insert(created, at: 0)
        }
    }

    func reset() {
        directConversations = []
        channels = []
        users = []
        visibleConversation = nil
        directState = .idle
        channelsState = .idle
        usersState = .idle
        typingResetTimers.values.forEach { $0.cancel() }
        typingResetTimers = [:]
        typingUsers = [:]
    }

    // MARK: - Realtime

    func handle(_ event: WSServerEvent) {
        switch event {
        case .newMessage(let message, _):
            handleIncomingMessage(message)

        case .userTyping(let userId, let userName, let conversationType, let targetId, let isTyping):
            handleTypingIndicator(
                userId: userId,
                userName: userName,
                conversationType: conversationType,
                targetId: targetId,
                isTyping: isTyping
            )

        case .userStatusChanged(let userId, let status, let customStatus):
            updateUserPresence(userId: userId, status: status, customStatus: customStatus)

        case .channelCreated(let channel):
            if !channels.contains(where: { $0.id == channel.id }) {
                channels.insert(channel, at: 0)
            }

        case .channelDeleted(let channelId):
            channels.removeAll { $0.id == channelId }

        case .conversationRead(let conversation, _, _, _):
            // Read on another device of mine (multi-device.md §6).
            markConversationRead(conversation)

        default:
            break
        }
    }

    private func handleIncomingMessage(_ message: Message) {
        let currentUserId = session.currentUser?.id
        if message.conversationType == .direct {
            let partnerId = (message.senderId == currentUserId) ? message.targetId : message.senderId
            let isOnScreen = visibleConversation == ConversationKey(type: .direct, targetId: partnerId)
            if let index = directConversations.firstIndex(where: { $0.userId == partnerId }) {
                directConversations[index].lastMessageId = message.id
                directConversations[index].lastMessageText = message.text
                directConversations[index].lastMessageTime = message.createdAt
                directConversations[index].lastMessageSenderId = message.senderId
                directConversations[index].lastMessageType = message.type
                if message.senderId != currentUserId && !isOnScreen {
                    directConversations[index].unreadCount += 1
                }
                let updated = directConversations.remove(at: index)
                directConversations.insert(updated, at: 0)
            } else {
                // A dialog we do not know yet: fetch the list that contains it.
                Task { await loadDirectConversations() }
            }
        } else {
            let isOnScreen = visibleConversation == ConversationKey(type: .channel, targetId: message.targetId)
            if let index = channels.firstIndex(where: { $0.id == message.targetId }) {
                channels[index].lastMessageText = message.text
                channels[index].lastMessageTime = message.createdAt
                if message.senderId != currentUserId && !isOnScreen {
                    channels[index].unreadCount += 1
                }
                let updated = channels.remove(at: index)
                channels.insert(updated, at: 0)
            }
        }
    }

    private func handleTypingIndicator(
        userId: Int64,
        userName: String,
        conversationType: ConversationType,
        targetId: Int64,
        isTyping: Bool
    ) {
        // For direct dialogs the server sends targetId = recipient (us); the dialog is the typist's.
        let dialogTarget = conversationType == .direct ? userId : targetId
        let key = Self.typingKey(for: ConversationKey(type: conversationType, targetId: dialogTarget))
        if isTyping {
            typingUsers[key] = String(localized: "\(userName) печатает...")

            // Автосброс через 3 секунды
            typingResetTimers[key]?.cancel()
            typingResetTimers[key] = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 3 * 1_000_000_000)
                guard !Task.isCancelled else { return }
                self?.typingUsers.removeValue(forKey: key)
            }
        } else {
            typingResetTimers[key]?.cancel()
            typingUsers.removeValue(forKey: key)
        }
    }

    private func updateUserPresence(userId: Int64, status: UserStatus, customStatus: String?) {
        if let index = users.firstIndex(where: { $0.id == userId }) {
            users[index].status = status
            users[index].customStatus = customStatus
        }
        if let index = directConversations.firstIndex(where: { $0.userId == userId }) {
            directConversations[index].status = status
            directConversations[index].customStatus = customStatus
        }
    }
}
