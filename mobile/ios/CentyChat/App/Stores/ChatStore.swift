import Foundation
import Observation

/// Messages of one conversation: what the delivery model holds for it (`delivery-state.md` §3.4),
/// projected for the screen, and the user's actions on it — all through the delivery engine, the
/// only writer of message frames.
@Observable
@MainActor
public final class ChatStore: RealtimeEventHandling {
    public let conversation: ConversationKey
    /// Server messages by id, then the queue by `seq`, then files still going up.
    public private(set) var messages: [Message] = []
    public private(set) var loadState: LoadState = .idle
    /// True while the chat screen is on screen.
    public private(set) var isVisible = false
    /// The newest page was loaded once (the screen stops showing the spinner).
    public private(set) var reachedStart = false
    public private(set) var isLoadingOlder = false
    /// A short notice for the open chat (a refused file, a delete the server did not take…).
    public private(set) var notice: ChatNotice?

    @ObservationIgnored private let repository: any ChatRepository
    @ObservationIgnored private let realtime: RealtimeStore
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private let conversations: ConversationsStore
    @ObservationIgnored private let delivery: DeliveryRuntime
    /// Tells the server which chat this device shows (`viewing`).
    @ObservationIgnored private let presenceController: PresenceController?
    @ObservationIgnored private let projection: ChatProjection
    @ObservationIgnored private var lastTypingSent = Date.distantPast
    @ObservationIgnored private var lastInput: ProjectionInput?
    @ObservationIgnored private var noticeSerial = 0

    static let pageSize = 50

    init(
        conversation: ConversationKey,
        repository: any ChatRepository,
        realtime: RealtimeStore,
        session: SessionStore,
        conversations: ConversationsStore,
        delivery: DeliveryRuntime,
        presenceController: PresenceController? = nil
    ) {
        self.conversation = conversation
        self.repository = repository
        self.realtime = realtime
        self.session = session
        self.conversations = conversations
        self.delivery = delivery
        self.presenceController = presenceController
        self.projection = ChatProjection(conversationType: conversation.type, targetId: conversation.targetId)
        rebuild()
    }

    private var key: String { conversation.deliveryKey }
    private var engine: DeliveryEngine { delivery.engine }
    private var uploads: AttachmentUploads { delivery.uploads }

    // MARK: - Projection

    /// What the projection of this chat depends on; unchanged input — nothing to rebuild.
    private struct ProjectionInput: Equatable {
        let me: Int64?
        let owner: Int64?
        let messages: [Msg]?
        let outbox: [OutboxEntry]
        let deleting: [Int64]
        let uploads: [AttachmentUploads.Item]
        let handedOver: [String]
        let myName: String
    }

    /// Rebuilds `messages` when this chat's part of the model changed.
    func rebuild() {
        let state = engine.state
        let me = session.currentUser?.id
        let input = ProjectionInput(
            me: me,
            owner: state.me,
            messages: state.messages[key],
            outbox: state.outbox.filter { $0.conversation == key },
            deleting: state.ops.filter { $0.op == DeliveryOp.delete }.compactMap(\.messageId),
            uploads: uploads.items.filter { $0.pending.conversation == key },
            handedOver: uploads.handedOver.keys.sorted(),
            myName: session.currentUser?.fullName ?? ""
        )
        guard input != lastInput else { return }
        lastInput = input
        guard let me else {
            messages = []
            return
        }
        let files = uploads.files
        messages = projection.build(
            state: state,
            me: me,
            myName: input.myName.isEmpty ? String(localized: "Я") : input.myName,
            uploads: input.uploads,
            handedOver: uploads.handedOver,
            fileURL: { files.url($0) }
        )
    }

    // MARK: - Visibility

    @ObservationIgnored private var presence = ChatScreenPresence()

    /// The chat screen appeared. `sceneIsActive` is `scenePhase == .active`.
    public func screenDidAppear(sceneIsActive: Bool) {
        presence.appeared = true
        presence.sceneIsActive = sceneIsActive
        applyPresence()
    }

    public func screenDidDisappear() {
        presence.appeared = false
        applyPresence()
    }

    /// The app moved between foreground and background while the screen may be shown.
    /// Coming back to an open chat marks what arrived meanwhile as read.
    public func sceneActivityChanged(isActive: Bool) async {
        presence.sceneIsActive = isActive
        applyPresence()
    }

    /// While visible, incoming messages are marked read instead of raising the unread counter
    /// (`conversation_opened` / `conversation_closed`, §7.8).
    private func applyPresence() {
        let wasVisible = isVisible
        isVisible = presence.isVisible
        conversations.setConversation(conversation, visible: isVisible)
        if isVisible && !wasVisible {
            conversations.markConversationRead(conversation)
            engine.conversationOpened(key)
        } else if !isVisible && wasVisible, engine.state.visible == key {
            engine.conversationClosed()
        }
        // The server hears only the open screen; foreground/background is the presence controller's.
        if presence.appeared {
            presenceController?.setViewing(conversation)
        } else {
            presenceController?.clearViewing(conversation)
        }
    }

    // MARK: - Loading

    /// Ids of this chat's server messages in the model now.
    private func serverIds() -> Set<Int64> {
        Set((engine.state.messages[key] ?? []).map(\.id))
    }

    /// The newest page replaces what the model holds from that page on: messages the server no longer
    /// returns there (hidden by a block, gone) are dropped; older history (a jump's window) stays.
    public func load() async {
        loadState = .loading
        let shownBefore = serverIds()
        do {
            let records = try await repository.messageRecords(in: conversation, limit: Self.pageSize, beforeId: nil)
            let oldest = records.compactMap { $0["id"]?.int64 }.min()
            let stale = oldest.map { first in shownBefore.filter { $0 >= first } } ?? shownBefore
            try await engine.replaceHistory(key, records: records, stale: stale, owner: session.currentUser?.id)
            if records.count < Self.pageSize { reachedStart = true }
            rebuild()
            loadState = .loaded
        } catch {
            Log.chat.error("Loading messages failed: \(error.localizedDescription, privacy: .public)")
            // What the model already holds stays on screen.
            loadState = .failed(error.userMessage)
        }
    }

    /// Opens the conversation at `messageId` (a search hit): the history around it is loaded next to
    /// the newest page. Returns false when the message is not there (deleted, no access).
    public func loadAround(_ messageId: Int64) async -> Bool {
        // What is on screen is already continuous up to the newest message.
        if messages.contains(where: { $0.id == messageId }) { return true }
        let repository = self.repository
        let conversation = self.conversation
        let window: [MessageRecord]?
        do {
            window = try await HistoryWindow.around(
                messageId,
                before: { beforeId, limit in
                    try await repository.messageRecords(in: conversation, limit: limit, beforeId: beforeId).compactMap(MessageRecord.init)
                },
                after: { afterId, limit in
                    try await repository.messageRecords(in: conversation, limit: limit, afterId: afterId).compactMap(MessageRecord.init)
                }
            )
        } catch {
            Log.chat.error("Loading the history around a message failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
        // Gone or too far back: the chat stays on its newest page, without a second stretch.
        guard let window, let newest = window.last?.id else { return false }
        // The window replaces the history up to its newest message; what arrived meanwhile stays.
        let stale = serverIds().filter { $0 <= newest }
        do {
            try await engine.replaceHistory(key, records: window.map(\.json), stale: stale, owner: session.currentUser?.id)
        } catch {
            Log.chat.error("Applying the history around a message failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
        rebuild()
        return true
    }

    /// The page before the oldest loaded message (`beforeId`), when the reader reaches the top.
    public func loadOlder() async {
        guard !isLoadingOlder, !reachedStart, let oldest = engine.state.messages[key]?.first?.id else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            let records = try await repository.messageRecords(in: conversation, limit: Self.pageSize, beforeId: oldest)
            if records.count < Self.pageSize { reachedStart = true }
            if !records.isEmpty { await engine.historyPage(records, owner: session.currentUser?.id) }
            rebuild()
        } catch {
            // The next scroll to the top asks again.
            Log.chat.error("Loading older messages failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Marks the open chat read (the screen finished loading).
    public func markAsRead() async {
        conversations.markConversationRead(conversation)
        if isVisible { engine.conversationOpened(key) }
    }

    // MARK: - Outgoing

    public func sendTypingIfNeeded(now: Date = Date()) async {
        guard now.timeIntervalSince(lastTypingSent) > 2.0 else { return }
        lastTypingSent = now
        await realtime.send(.typing(conversationType: conversation.type, targetId: conversation.targetId, isTyping: true))
    }

    /// Queues a text message. True once it is on disk: only then may the composer clear (§7.4).
    @discardableResult
    public func send(text rawText: String, replyTo: Message? = nil) async -> Bool {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let me = session.currentUser?.id else { return false }
        let outcome = await engine.enqueue(
            conversation: key,
            text: text,
            replyToId: replyTo.flatMap { $0.id > 0 ? $0.id : nil },
            owner: me
        )
        rebuild()
        if !outcome.composerCleared {
            show(DeliveryNotices.text(outcome.userError) ?? String(localized: "Сообщение не сохранено — попробуйте ещё раз"))
        }
        return outcome.composerCleared
    }

    /// Queues a picked file: a private copy first, then the upload, then the outbox. False — nothing
    /// was queued (`notice` says why).
    @discardableResult
    func sendAttachment(_ picked: PickedAttachment, replyTo: Message? = nil) async -> Bool {
        guard let me = session.currentUser?.id else { return false }
        let policy = try? await repository.filePolicy()
        let size: Int64? = switch picked.source {
        case .data(let data): Int64(data.count)
        case .file(let url): (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value
        }
        if let problem = AttachmentRules.problem(name: picked.name, size: size, policy: policy) {
            show(problem)
            return false
        }
        let accepted = await uploads.add(conversation: key, picked: picked, replyToId: replyTo.flatMap { $0.id > 0 ? $0.id : nil }, owner: me)
        rebuild()
        if !accepted { show(String(localized: "Не удалось подготовить файл к отправке")) }
        return accepted
    }

    /// A new text for an own message: a confirmed one through `ops` (shown once the server confirms),
    /// an unsent one at once (§7.10).
    @discardableResult
    public func edit(_ message: Message, text rawText: String) async -> Bool {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text != message.text else { return false }
        let outcome: DeliveryEngine.Outcome
        if message.sendState != nil, let clientMsgId = message.clientMsgId {
            outcome = await engine.edit(clientMsgId: clientMsgId, text: text)
        } else {
            outcome = await engine.edit(messageId: message.id, text: text)
        }
        rebuild()
        if let error = outcome.userError { show(DeliveryNotices.text(error) ?? String(localized: "Сообщение нельзя изменить")) }
        return outcome.persisted && outcome.userError == nil
    }

    /// «Удалить»: a confirmed own message is deleted (hidden until the tombstone), an unsent one is
    /// withdrawn and never sent later; an administrator deleting someone else's message asks the
    /// server directly.
    public func delete(_ message: Message) async {
        if message.sendState != nil, let clientMsgId = message.clientMsgId {
            if engine.state.outbox.contains(where: { $0.clientMsgId == clientMsgId }) {
                _ = await engine.cancel(clientMsgId: clientMsgId)
            } else {
                await uploads.cancel(clientMsgId)
            }
        } else if message.senderId == session.currentUser?.id {
            let outcome = await engine.delete(messageId: message.id)
            if let error = outcome.userError { show(DeliveryNotices.text(error) ?? String(localized: "Сообщение нельзя удалить")) }
        } else {
            // Moderation of another person's message is outside the delivery model (§6.3 `delete`).
            await realtime.send(.deleteMessage(messageId: message.id))
        }
        rebuild()
    }

    /// «Повторить» on a message that was not sent.
    public func retry(_ message: Message) async {
        guard message.sendState == .failed, let clientMsgId = message.clientMsgId else { return }
        if engine.state.outbox.contains(where: { $0.clientMsgId == clientMsgId }) {
            _ = await engine.retry(clientMsgId: clientMsgId)
        } else {
            uploads.retry(clientMsgId)
        }
        rebuild()
    }

    /// A delivery `user_error` or a refused file of this chat, while it is on screen.
    func deliveryNotice(code: String) {
        guard isVisible, let text = DeliveryNotices.text(code) else { return }
        show(text)
    }

    func uploadNotice(_ notice: AttachmentUploads.Notice) {
        guard isVisible, notice.conversation == key else { return }
        show(notice.text)
    }

    private func show(_ text: String) {
        noticeSerial += 1
        notice = ChatNotice(text: text, serial: noticeSerial)
    }

    public func dismissNotice() {
        notice = nil
    }

    // MARK: - Realtime

    /// Message frames reach the chat through the delivery engine; nothing to do here.
    func handle(_ event: WSServerEvent) {}
}

/// A short message for the open chat.
public struct ChatNotice: Equatable, Sendable {
    public let text: String
    public let serial: Int
}

/// The Russian text of a delivery `user_error` code (`delivery-state.md` §5).
enum DeliveryNotices {
    static func text(_ code: String?) -> String? {
        switch code {
        case nil: return nil
        case "EMPTY_TEXT": return String(localized: "Нельзя отправить пустое сообщение")
        case "TEXT_TOO_LONG": return String(localized: "Сообщение длиннее 16 000 символов")
        case "NOT_EDITABLE", "EDIT_REJECTED": return String(localized: "Сообщение нельзя изменить")
        case "NOT_DELETABLE", "DELETE_REJECTED": return String(localized: "Сообщение нельзя удалить")
        case "DELETE_NOT_CONFIRMED": return String(localized: "Сервер не подтвердил удаление — сообщение снова видно")
        default: return String(localized: "Сообщение не сохранено — попробуйте ещё раз")
        }
    }
}

/// Whether the user can actually see a chat: the screen is shown and the app is in the foreground.
struct ChatScreenPresence: Equatable {
    var appeared = false
    var sceneIsActive = true

    var isVisible: Bool { appeared && sceneIsActive }
}

/// Creates and caches one `ChatStore` per conversation for the current session, and tells them when
/// the delivery model or the file queue changed.
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

    /// The delivery model or the file queue changed: each open chat rebuilds its part.
    func modelChanged() {
        for store in stores.values {
            store.rebuild()
        }
    }

    func deliveryNotice(code: String) {
        for store in stores.values {
            store.deliveryNotice(code: code)
        }
    }

    func uploadNotice(_ notice: AttachmentUploads.Notice) {
        for store in stores.values {
            store.uploadNotice(notice)
        }
    }

    /// Refreshes conversations that were already open, e.g. after a reconnect.
    func reloadLoaded() async {
        for store in stores.values where store.loadState == .loaded {
            await store.load()
        }
    }

    func handle(_ event: WSServerEvent) {}
}
