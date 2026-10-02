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
    /// True while the chat screen is on screen.
    public private(set) var isVisible = false

    @ObservationIgnored private let repository: any ChatRepository
    @ObservationIgnored private let realtime: RealtimeStore
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private let conversations: ConversationsStore
    @ObservationIgnored private var lastTypingSent = Date.distantPast
    /// Optimistic messages awaiting the server echo; they use negative ids.
    @ObservationIgnored private var pendingMessageIDs: [Int64] = []
    @ObservationIgnored private var nextPendingID: Int64 = -1

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

    // MARK: - Visibility

    public func setVisible(_ visible: Bool) {
        isVisible = visible
    }

    // MARK: - Loading

    public func load() async {
        loadState = .loading
        do {
            let loaded = try await repository.messages(in: conversation, limit: 50, beforeId: nil)
            // Keep what arrived over realtime (or is still pending) while the page was loading.
            let loadedIDs = Set(loaded.map(\.id))
            messages = loaded + messages.filter { !loadedIDs.contains($0.id) }
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

        // Оптимистичное добавление; заменяется эхом сервера с настоящим id
        let pendingID = nextPendingID
        nextPendingID -= 1
        pendingMessageIDs.append(pendingID)
        let pending = Message(
            id: pendingID,
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
        case .newMessage(let message):
            if belongsHere(message) {
                receive(message)
            }
        case .messageStatusUpdated(let messageId, let status, _, _):
            updateMessage(id: messageId) { $0.deliveryStatus = status }
        case .messagesRead(let byUserId, let messageIds):
            guard conversation == ConversationKey(type: .direct, targetId: byUserId) else { return }
            let readIDs = Set(messageIds)
            for index in messages.indices where readIDs.contains(messages[index].id) {
                messages[index].deliveryStatus = .read
            }
        case .messageUpdated(let messageId, let text, let updatedAt):
            updateMessage(id: messageId) {
                $0.text = text
                $0.updatedAt = updatedAt ?? Date()
            }
        case .messageDeleted(let messageId, _, _):
            // targetId in this event is the stored target, not relative to us: match by id only.
            updateMessage(id: messageId) {
                $0.isDeleted = true
                $0.text = ""
                $0.metadata = nil
            }
        default:
            break
        }
    }

    private func belongsHere(_ message: Message) -> Bool {
        guard message.conversationType == conversation.type else { return false }
        switch conversation.type {
        case .channel:
            return message.targetId == conversation.targetId
        case .direct:
            let partner = message.senderId == session.currentUser?.id ? message.targetId : message.senderId
            return partner == conversation.targetId
        }
    }

    private func receive(_ incoming: Message) {
        var message = incoming
        let isOwn = message.senderId == session.currentUser?.id
        if isOwn, message.deliveryStatus == nil {
            // Live frames carry no delivery status; the server has stored the message.
            message.deliveryStatus = .sent
        }
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            messages[index] = message
            return
        }
        if isOwn,
           let index = messages.firstIndex(where: {
               pendingMessageIDs.contains($0.id) && $0.text == message.text && $0.type == message.type
           }) {
            pendingMessageIDs.removeAll { $0 == messages[index].id }
            messages[index] = message
            return
        }
        messages.append(message)
    }

    private func updateMessage(id: Int64, _ change: (inout Message) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[index])
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

    /// Refreshes conversations that were already open, e.g. after a reconnect.
    func reloadLoaded() async {
        for store in stores.values where store.loadState == .loaded {
            await store.load()
        }
    }

    func handle(_ event: WSServerEvent) {
        for store in stores.values {
            store.handle(event)
        }
    }
}
