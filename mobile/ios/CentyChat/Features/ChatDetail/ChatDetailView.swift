import SwiftUI
import PhotosUI

/// Детальный экран диалога или канала с поддержкой сообщений, вложений, тайпинга и звонков
public struct ChatDetailView: View {
    @Environment(AppContainer.self) private var container

    public let conversationType: ConversationType
    public let targetId: Int64
    public let title: String
    public let avatarUrl: String?
    public let status: UserStatus?
    /// Open the chat at this message (a search hit) and pulse it.
    public let highlightMessageId: Int64?

    public init(
        conversationType: ConversationType,
        targetId: Int64,
        title: String,
        avatarUrl: String? = nil,
        status: UserStatus? = nil,
        highlightMessageId: Int64? = nil
    ) {
        self.conversationType = conversationType
        self.targetId = targetId
        self.title = title
        self.avatarUrl = avatarUrl
        self.status = status
        self.highlightMessageId = highlightMessageId
    }

    public var body: some View {
        ChatDetailContent(
            store: container.chats.store(for: ConversationKey(type: conversationType, targetId: targetId)),
            title: title,
            avatarUrl: avatarUrl,
            status: status,
            highlightMessageId: highlightMessageId
        )
    }
}

/// Where the message list should scroll once: the jump target (pulsed) or the bottom.
private struct ScrollRequest: Equatable {
    let messageId: Int64
    let pulses: Bool
}

/// The chat screen bound to one `ChatStore`.
private struct ChatDetailContent: View {
    @Environment(SessionStore.self) private var session
    @Environment(ConversationsStore.self) private var conversations
    @Environment(CallStore.self) private var calls
    @Environment(AccountStore.self) private var account
    @Environment(\.scenePhase) private var scenePhase

    let store: ChatStore
    let title: String
    let avatarUrl: String?
    let status: UserStatus?
    let highlightMessageId: Int64?

    @State private var inputText: String = ""
    /// The search hit was looked up (found or not); from then on the list follows new messages.
    @State private var jumpHandled = false
    @State private var scrollRequest: ScrollRequest?
    /// The message pulsing for 1.2 s after a jump.
    @State private var pulsingMessageId: Int64?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var editingMessage: Message? = nil
    @State private var reportTarget: ReportTarget? = nil
    @State private var blockCandidate: BlockCandidate? = nil
    @State private var safetyError: String? = nil

    // Вложения
    @State private var selectedPhotoItem: PhotosPickerItem? = nil

    private var conversationType: ConversationType { store.conversation.type }
    private var targetId: Int64 { store.conversation.targetId }

    private var typingText: String? {
        conversations.typingUsers[ConversationsStore.typingKey(for: store.conversation)]
    }

    private struct BlockCandidate: Equatable {
        let userId: Int64
        let name: String
    }

    /// Messages of people the user blocked are hidden on this device.
    private var visibleMessages: [Message] {
        store.messages.filter { !account.isBlocked($0.senderId) }
    }

    private var blockSenderHandler: ((Message) -> Void)? {
        guard conversationType == .channel else { return nil }
        return { msg in
            blockCandidate = BlockCandidate(userId: msg.senderId, name: msg.senderName)
        }
    }

    private var isPeerBlocked: Bool {
        conversationType == .direct && account.isBlocked(targetId)
    }

    /// The per-person menu exists only in a dialog with someone else.
    private var showsPersonMenu: Bool {
        conversationType == .direct && targetId != session.currentUser?.id
    }

    private var isCallingAllowed: Bool {
        conversationType == .direct && (session.currentUser?.permissions?.canCall ?? true)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Список сообщений
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(visibleMessages) { message in
                            MessageBubbleView(
                                message: message,
                                isCurrentUser: message.senderId == session.currentUser?.id,
                                showSenderHeader: conversationType == .channel,
                                onEdit: { msg in
                                    editingMessage = msg
                                    inputText = msg.text
                                },
                                onDelete: { msg in
                                    Task {
                                        await store.delete(msg)
                                        CentyHaptics.warning()
                                    }
                                },
                                onReport: { msg in
                                    reportTarget = ReportTarget(type: .message, id: msg.id, subject: reportExcerpt(of: msg))
                                },
                                onBlockSender: blockSenderHandler
                            )
                            // The search hit pulses once the chat scrolled to it.
                            .background(
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .fill(CentyColors.primarySoft)
                                    .padding(-4)
                                    .opacity(pulsingMessageId == message.id ? 1 : 0)
                            )
                            .id(message.id)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .background(CentyColors.chatBackground)
                .onChange(of: store.messages.count) {
                    // Opening at a search hit: the list waits for the history around it.
                    guard isFollowingBottom, let last = store.messages.last else { return }
                    withAnimation {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
                .onChange(of: scrollRequest) { _, request in
                    guard let request else { return }
                    proxy.scrollTo(request.messageId, anchor: request.pulses ? .center : .bottom)
                    if request.pulses { pulse(request.messageId) }
                }
                .onAppear {
                    if isFollowingBottom, let last = store.messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }

            // Индикатор набора текста
            if let typingText {
                HStack {
                    TypingIndicatorView(text: typingText)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
                .background(Color(uiColor: .systemBackground))
            }

            // Баннер редактирования сообщения
            if let editMsg = editingMessage {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Редактирование")
                            .font(.caption.weight(.bold))
                            .foregroundColor(CentyColors.primaryBlue)
                        Text(editMsg.text)
                            .font(.caption)
                            .lineLimit(1)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    Button(action: {
                        editingMessage = nil
                        inputText = ""
                    }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                    }
                    .accessibilityLabel("Отменить редактирование")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .background(Color(uiColor: .secondarySystemBackground))
            }

            // Баннер блокировки собеседника
            if isPeerBlocked {
                HStack(spacing: 8) {
                    Image(systemName: "hand.raised.fill")
                        .foregroundColor(CentyColors.dangerText)
                        .accessibilityHidden(true)
                    Text("Вы заблокировали этого пользователя. Его сообщения скрыты.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                    Spacer(minLength: 8)
                    Button("Разблокировать") { unblockPeer() }
                        .font(.footnote.weight(.semibold))
                        .accessibilityIdentifier("chat-unblock-banner")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color(uiColor: .secondarySystemBackground))
                .accessibilityElement(children: .contain)
            }

            // Панель ввода сообщения
            inputBar
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 2) {
                    Text(title)
                        .font(.headline)
                        .lineLimit(1)
                    if let status = status, conversationType == .direct {
                        HStack(spacing: 4) {
                            StatusBadge(status: status, size: 8)
                            Text(status.displayName)
                                .font(.caption2)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }

            ToolbarItem(placement: .navigationBarTrailing) {
                HStack(spacing: 12) {
                    if showsPersonMenu {
                        Menu {
                            if isPeerBlocked {
                                Button {
                                    unblockPeer()
                                } label: {
                                    Label("Разблокировать", systemImage: "hand.raised.slash")
                                }
                            } else {
                                Button(role: .destructive) {
                                    blockCandidate = BlockCandidate(userId: targetId, name: title)
                                } label: {
                                    Label("Заблокировать", systemImage: "hand.raised")
                                }
                            }
                            Button {
                                reportTarget = ReportTarget(type: .user, id: targetId, subject: title)
                            } label: {
                                Label("Пожаловаться на пользователя", systemImage: "flag")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .foregroundColor(CentyColors.primaryBlue)
                        }
                        .accessibilityLabel("Действия с пользователем")
                        .accessibilityIdentifier("chat-person-menu")
                    }
                    if isCallingAllowed {
                        Button(action: {
                            Task {
                                let colleague = PublicUser(id: targetId, username: "", fullName: title, avatarUrl: avatarUrl, status: status ?? .online)
                                await calls.startOutgoingCall(targetUser: colleague)
                            }
                        }) {
                            Image(systemName: "phone.fill")
                                .foregroundColor(CentyColors.primaryBlue)
                        }
                        .accessibilityLabel("Позвонить")
                    }
                }
            }
        }
        .onAppear {
            store.screenDidAppear(sceneIsActive: scenePhase == .active)
        }
        .onDisappear {
            store.screenDidDisappear()
        }
        .onChange(of: scenePhase) {
            let isActive = scenePhase == .active
            Task { await store.sceneActivityChanged(isActive: isActive) }
        }
        .task {
            await store.load()
            if let target = highlightMessageId, !jumpHandled {
                let found = await store.loadAround(target)
                jumpHandled = true
                if found {
                    scrollRequest = ScrollRequest(messageId: target, pulses: true)
                } else if let last = store.messages.last {
                    scrollRequest = ScrollRequest(messageId: last.id, pulses: false)
                }
            }
            await store.markAsRead()
        }
        .sheet(item: $reportTarget) { target in
            ReportSheetView(target: target)
        }
        .alert(
            "Заблокировать пользователя?",
            isPresented: Binding(get: { blockCandidate != nil }, set: { if !$0 { blockCandidate = nil } })
        ) {
            Button("Отмена", role: .cancel) { blockCandidate = nil }
            Button("Заблокировать", role: .destructive) { confirmBlock() }
        } message: {
            Text("Сообщения «\(blockCandidate?.name ?? "")» будут скрыты на этом устройстве. Разблокировать можно в чате или в профиле.")
        }
        .alert(
            "Не удалось выполнить действие",
            isPresented: Binding(get: { safetyError != nil }, set: { if !$0 { safetyError = nil } })
        ) {
            Button("ОК", role: .cancel) {}
        } message: {
            Text(safetyError ?? "")
        }
    }

    // MARK: - Jump to a search hit

    /// New messages scroll the list down, except while the chat is still opening at a search hit.
    private var isFollowingBottom: Bool {
        highlightMessageId == nil || jumpHandled
    }

    /// A 1.2 s highlight on the bubble the search led to (a plain fade with Reduce Motion).
    private func pulse(_ messageId: Int64) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
            pulsingMessageId = messageId
        }
        Task {
            try? await Task.sleep(for: .milliseconds(1_200))
            guard pulsingMessageId == messageId else { return }
            withAnimation(.easeOut(duration: reduceMotion ? 0.15 : 0.4)) {
                pulsingMessageId = nil
            }
        }
    }

    // MARK: - Safety actions

    private func reportExcerpt(of message: Message) -> String {
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = text.isEmpty ? String(localized: "Вложение") : String(text.prefix(160))
        return "\(message.senderName): \(body)"
    }

    private func confirmBlock() {
        guard let candidate = blockCandidate else { return }
        blockCandidate = nil
        Task {
            if let failure = await account.block(userId: candidate.userId, name: candidate.name) {
                safetyError = failure.message(at: .now)
                CentyHaptics.error()
            } else {
                CentyHaptics.warning()
            }
        }
    }

    private func unblockPeer() {
        Task {
            if let failure = await account.unblock(userId: targetId) {
                safetyError = failure.message(at: .now)
                CentyHaptics.error()
            }
        }
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(spacing: 8) {
            // Кнопка вложения
            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                Image(systemName: "paperclip")
                    .font(.system(size: 20))
                    .foregroundColor(CentyColors.primaryBlue)
            }
            .accessibilityLabel("Прикрепить фото")
            .onChange(of: selectedPhotoItem) {
                Task { await handleSelectedPhoto() }
            }

            // Текстовое поле ввода
            TextField("Сообщение...", text: $inputText)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(uiColor: .secondarySystemBackground))
                .clipShape(Capsule())
                .onChange(of: inputText) {
                    Task { await store.sendTypingIfNeeded() }
                }

            // Кнопка отправки
            Button(action: {
                Task { await sendOrUpdateMessage() }
            }) {
                Image(systemName: editingMessage != nil ? "checkmark.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(inputText.trimmingCharacters(in: .whitespaces).isEmpty ? .gray : CentyColors.primaryBlue)
            }
            .accessibilityLabel(editingMessage != nil ? "Сохранить изменения" : "Отправить")
            .disabled(inputText.trimmingCharacters(in: .whitespaces).isEmpty || store.isUploadingAttachment)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemBackground))
    }

    // MARK: - Actions

    private func sendOrUpdateMessage() async {
        let text = inputText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }

        if let editing = editingMessage {
            editingMessage = nil
            inputText = ""
            await store.edit(editing, text: text)
        } else {
            inputText = ""
            await store.send(text: text)
        }
        CentyHaptics.light()
    }

    private func handleSelectedPhoto() async {
        guard let item = selectedPhotoItem else { return }
        defer { selectedPhotoItem = nil }

        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            if await store.sendImage(data: data) {
                CentyHaptics.success()
            } else {
                CentyHaptics.error()
            }
        } catch {
            Log.chat.error("Loading picked photo failed: \(error.localizedDescription, privacy: .public)")
            CentyHaptics.error()
        }
    }
}
