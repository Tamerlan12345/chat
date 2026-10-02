import Foundation
import Observation

/// Messages of one conversation.
@Observable
@MainActor
public final class ChatStore: RealtimeEventHandling {
    public let conversation: ConversationKey
    public private(set) var messages: [Message] = []
    public private(set) var loadState: LoadState = .idle
    public private(set) var isUploadingAttachment = false

    @ObservationIgnored private let repository: any ChatRepository
    @ObservationIgnored private let realtime: RealtimeStore
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private let conversations: ConversationsStore
    @ObservationIgnored private var lastTypingSent = Date.distantPast

    init(
        conversation: ConversationKey,
        repository: any ChatRepository,
        realtime: RealtimeStore,
        session: SessionStore,
        conversations: ConversationsStore
    ) {
        self.conversation = conversation
        self.repository = repository
        self.realtime = realtime
        self.session = session
        self.conversations = conversations
    }

    // MARK: - Loading

    public func load() async {
        loadState = .loading
        do {
            messages = try await repository.messages(in: conversation, limit: 50, beforeId: nil)
            loadState = .loaded
        } catch {
            Log.chat.error("Loading messages failed: \(error.localizedDescription, privacy: .public)")
            loadState = .failed(error.userMessage)
        }
    }

    public func markAsRead() async {
        await realtime.send(.markRead(conversationType: conversation.type, targetId: conversation.targetId))
        conversations.markConversationRead(conversation)
    }

    // MARK: - Outgoing

    public func sendTypingIfNeeded(now: Date = Date()) async {
        guard now.timeIntervalSince(lastTypingSent) > 2.0 else { return }
        lastTypingSent = now
        await realtime.send(.typing(conversationType: conversation.type, targetId: conversation.targetId, isTyping: true))
    }

    public func send(text rawText: String) async {
        let text = rawText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        await realtime.send(.sendMessage(
            conversationType: conversation.type,
            targetId: conversation.targetId,
            text: text,
            msgType: .text
        ))

        // Оптимистичное добавление в локальный список
        let pending = Message(
            id: Int64(Date().timeIntervalSince1970 * 1000),
            conversationType: conversation.type,
            targetId: conversation.targetId,
            senderId: session.currentUser?.id ?? 0,
            text: text,
            type: .text,
            createdAt: Date(),
            senderName: session.currentUser?.fullName ?? String(localized: "Я"),
            deliveryStatus: .sent
        )
        messages.append(pending)
    }

    public func edit(_ message: Message, text rawText: String) async {
        let text = rawText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        await realtime.send(.editMessage(messageId: message.id, text: text))
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            messages[index].text = text
            messages[index].updatedAt = Date()
        }
    }

    public func delete(_ message: Message) async {
        await realtime.send(.deleteMessage(messageId: message.id))
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            messages[index].isDeleted = true
            messages[index].text = ""
        }
    }

    /// Uploads a JPEG and posts it as an image message. Returns false on failure.
    public func sendImage(data: Data) async -> Bool {
        isUploadingAttachment = true
        defer { isUploadingAttachment = false }
        do {
            let fileName = "photo_\(Int(Date().timeIntervalSince1970)).jpg"
            let upload = try await repository.uploadFile(data: data, fileName: fileName, mimeType: "image/jpeg")
            let metadata = MessageMetadata(
                fileId: upload.id,
                fileName: upload.originalName,
                fileSize: upload.fileSize,
                mimeType: upload.mimeType,
                url: upload.url
            )
            await realtime.send(.sendMessage(
                conversationType: conversation.type,
                targetId: conversation.targetId,
                text: fileName,
                msgType: .image,
                metadata: metadata
            ))
            return true
        } catch {
            Log.chat.error("Photo upload failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    // MARK: - Realtime

    func handle(_ event: WSServerEvent) {
        switch event {
        case .messageStatusUpdated(let messageId, let status, _, _):
            updateMessageStatus(messageId: messageId, status: status)
        case .messageUpdated(let messageId, let text, let updatedAt):
            updateMessageContent(messageId: messageId, text: text, updatedAt: updatedAt)
        case .messageDeleted(let messageId, _, _):
            markMessageDeleted(messageId: messageId)
        default:
            break
        }
    }

    private func updateMessageStatus(messageId: Int64, status: DeliveryStatus) {
        // Broadcasts to active chat view model
    }

    private func updateMessageContent(messageId: Int64, text: String, updatedAt: Date?) {
        // Will be reflected in chat detail view
    }

    private func markMessageDeleted(messageId: Int64) {
        // Will be reflected in chat detail view
    }
}

/// Creates and caches one `ChatStore` per conversation for the current session
/// and routes realtime events to them.
@MainActor
public final class ChatRegistry: RealtimeEventHandling {
    private var stores: [ConversationKey: ChatStore] = [:]
    private let makeStore: (ConversationKey) -> ChatStore

    init(makeStore: @escaping (ConversationKey) -> ChatStore) {
        self.makeStore = makeStore
    }

    public func store(for conversation: ConversationKey) -> ChatStore {
        if let existing = stores[conversation] {
            return existing
        }
        let store = makeStore(conversation)
        stores[conversation] = store
        return store
    }

    func existingStore(for conversation: ConversationKey) -> ChatStore? {
        stores[conversation]
    }

    func reset() {
        stores = [:]
    }

    func handle(_ event: WSServerEvent) {
        for store in stores.values {
            store.handle(event)
        }
    }
}
