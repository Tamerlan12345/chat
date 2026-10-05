import PhotosUI
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

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
            opener: AttachmentOpener(downloader: container.downloads, typeForExtension: SystemFileTypes.mimeType(forExtension:)),
            thumbnails: container.thumbnails,
            title: title,
            avatarUrl: avatarUrl,
            status: status,
            highlightMessageId: highlightMessageId
        )
    }
}

/// Where the message list should scroll once: the jump target (pulsed) or the bottom.
private struct ScrollRequest: Equatable {
    let rowID: String
    let pulses: Bool
}

/// The chat screen bound to one `ChatStore`.
private struct ChatDetailContent: View {
    @Environment(SessionStore.self) private var session
    @Environment(ConversationsStore.self) private var conversations
    @Environment(CallStore.self) private var calls
    @Environment(AccountStore.self) private var account
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let store: ChatStore
    @State var opener: AttachmentOpener
    let thumbnails: AttachmentThumbnails
    let title: String
    let avatarUrl: String?
    let status: UserStatus?
    let highlightMessageId: Int64?

    init(store: ChatStore, opener: AttachmentOpener, thumbnails: AttachmentThumbnails, title: String, avatarUrl: String?, status: UserStatus?, highlightMessageId: Int64?) {
        self.store = store
        _opener = State(initialValue: opener)
        self.thumbnails = thumbnails
        self.title = title
        self.avatarUrl = avatarUrl
        self.status = status
        self.highlightMessageId = highlightMessageId
    }

    @State private var inputText: String = ""
    @State private var isSending = false
    /// The search hit was looked up (found or not); from then on the list follows new messages.
    @State private var jumpHandled = false
    @State private var scrollRequest: ScrollRequest?
    /// The message pulsing for 1.2 s after a jump.
    @State private var pulsingRowID: String?
    @State private var editingMessage: Message?
    @State private var replyingTo: Message?
    @State private var deleteCandidate: Message?
    @State private var reportTarget: ReportTarget?
    @State private var blockCandidate: BlockCandidate?
    @State private var safetyError: String?
    @State private var noticeText: String?

    // Вложения
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var showsPhotoPicker = false
    @State private var showsFileImporter = false

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
    private var rows: [ChatRow] {
        ChatTimeline.rows(store.messages.filter { !account.isBlocked($0.senderId) }, me: session.currentUser?.id)
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

    /// The role may send files (server: `can_upload_files` or an administrator).
    private var canAttach: Bool {
        let permissions = session.currentUser?.permissions
        return permissions?.isAdmin == true || permissions?.canUploadFiles != false
    }

    /// Nothing to send: empty, or only the contract's whitespace (§6.1, the server's `trim()`).
    private var inputIsBlank: Bool {
        DeliveryReducer.isBlank(inputText)
    }

    var body: some View {
        VStack(spacing: 0) {
            messageList

            if let typingText {
                HStack {
                    TypingIndicatorView(text: typingText)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
                .background(Color(uiColor: .systemBackground))
            }

            if let editMsg = editingMessage {
                composerBanner(title: "Редактирование", text: editMsg.text, closeLabel: "Отменить редактирование") {
                    editingMessage = nil
                    inputText = ""
                }
            } else if let reply = replyingTo {
                composerBanner(title: "Ответ \(reply.senderName)", text: reply.text, closeLabel: "Отменить ответ") {
                    replyingTo = nil
                }
            }

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

            inputBar
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
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
                if found, let row = store.messages.first(where: { $0.id == target }) {
                    scrollRequest = ScrollRequest(rowID: row.rowID, pulses: true)
                } else if let last = store.messages.last {
                    scrollRequest = ScrollRequest(rowID: last.rowID, pulses: false)
                }
            }
            await store.markAsRead()
        }
        .onChange(of: store.notice) { _, notice in
            if let notice { noticeText = notice.text }
        }
        .onChange(of: opener.notice) { _, notice in
            if let notice {
                noticeText = notice
                opener.notice = nil
            }
        }
        .sheet(item: $reportTarget) { target in
            ReportSheetView(target: target)
        }
        .quickLookPreview(Binding(
            get: { opener.preview?.url },
            set: { if $0 == nil { opener.preview = nil } }
        ))
        .sheet(item: $opener.shareable) { file in
            ShareSheet(url: file.url)
                .presentationDetents([.medium, .large])
        }
        .fullScreenCover(item: $opener.viewer) { attachment in
            AttachmentImageViewer(attachment: attachment, opener: opener, thumbnails: thumbnails)
        }
        .photosPicker(isPresented: $showsPhotoPicker, selection: $selectedPhotoItem, matching: .images)
        .onChange(of: selectedPhotoItem) {
            Task { await handleSelectedPhoto() }
        }
        .fileImporter(isPresented: $showsFileImporter, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
            Task { await handleImportedFile(result) }
        }
        .confirmationDialog(
            deleteTitle,
            isPresented: Binding(get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } }),
            titleVisibility: .visible
        ) {
            Button("Удалить", role: .destructive) { confirmDelete() }
            Button("Отмена", role: .cancel) { deleteCandidate = nil }
        } message: {
            Text(deleteMessage)
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
        .alert(
            "Сообщение",
            isPresented: Binding(get: { noticeText != nil }, set: { if !$0 { noticeText = nil; store.dismissNotice() } })
        ) {
            Button("ОК", role: .cancel) {}
        } message: {
            Text(noticeText ?? "")
        }
    }

    // MARK: - Message list

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 4) {
                    if !store.reachedStart && !rows.isEmpty {
                        ProgressView()
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .accessibilityLabel(Text("Загрузка более ранних сообщений"))
                            .onAppear { Task { await store.loadOlder() } }
                    }
                    ForEach(rows) { row in
                        if row.startsDay {
                            DaySeparator(date: row.message.createdAt)
                        }
                        MessageBubbleView(
                            message: row.message,
                            isCurrentUser: row.message.senderId == session.currentUser?.id,
                            showSenderHeader: conversationType == .channel && row.startsGroup,
                            showsMeta: row.showsMeta,
                            transfer: MessageAttachment.of(row.message)?.fileId.flatMap { opener.transfers[$0] },
                            thumbnails: thumbnails,
                            onAction: handle,
                            onOpenAttachment: { opener.open($0) }
                        )
                        .padding(.top, row.startsGroup ? 6 : 0)
                        // The search hit pulses once the chat scrolled to it.
                        .background(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(CentyColors.primarySoft)
                                .padding(-4)
                                .opacity(pulsingRowID == row.id ? 1 : 0)
                        )
                        .id(row.id)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(CentyColors.chatBackground)
            .onChange(of: store.messages.last?.rowID) { _, last in
                // Opening at a search hit: the list waits for the history around it.
                guard isFollowingBottom, let last else { return }
                withAnimation(reduceMotion ? nil : .default) {
                    proxy.scrollTo(last, anchor: .bottom)
                }
            }
            .onChange(of: scrollRequest) { _, request in
                guard let request else { return }
                proxy.scrollTo(request.rowID, anchor: request.pulses ? .center : .bottom)
                if request.pulses { pulse(request.rowID) }
            }
            .onAppear {
                if isFollowingBottom, let last = store.messages.last {
                    proxy.scrollTo(last.rowID, anchor: .bottom)
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
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

    // MARK: - Jump to a search hit

    /// New messages scroll the list down, except while the chat is still opening at a search hit.
    private var isFollowingBottom: Bool {
        highlightMessageId == nil || jumpHandled
    }

    /// A 1.2 s highlight on the bubble the search led to (a plain fade with Reduce Motion).
    private func pulse(_ rowID: String) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
            pulsingRowID = rowID
        }
        Task {
            try? await Task.sleep(for: .milliseconds(1_200))
            guard pulsingRowID == rowID else { return }
            withAnimation(.easeOut(duration: reduceMotion ? 0.15 : 0.4)) {
                pulsingRowID = nil
            }
        }
    }

    // MARK: - Message actions

    private func handle(_ action: MessageMenuPolicy.Action, _ message: Message) {
        switch action {
        case .reply:
            editingMessage = nil
            replyingTo = message
        case .copy:
            break
        case .edit:
            replyingTo = nil
            editingMessage = message
            inputText = message.text
        case .retry:
            Task { await store.retry(message) }
        case .delete:
            deleteCandidate = message
        case .report:
            reportTarget = ReportTarget(type: .message, id: message.id, subject: reportExcerpt(of: message))
        case .blockSender:
            blockCandidate = BlockCandidate(userId: message.senderId, name: message.senderName)
        }
    }

    private var deleteTitle: LocalizedStringKey {
        deleteCandidate?.sendState != nil ? "Не отправлять сообщение?" : "Удалить сообщение?"
    }

    private var deleteMessage: LocalizedStringKey {
        if deleteCandidate?.sendState != nil {
            return "Сообщение ещё не отправлено. Оно будет удалено с этого устройства и не будет отправлено."
        }
        if let candidate = deleteCandidate, candidate.senderId != session.currentUser?.id {
            return "Сообщение будет удалено у всех участников переписки."
        }
        return "Сообщение будет удалено у вас и у собеседника."
    }

    private func confirmDelete() {
        guard let message = deleteCandidate else { return }
        deleteCandidate = nil
        if editingMessage?.rowID == message.rowID {
            editingMessage = nil
            inputText = ""
        }
        Task {
            await store.delete(message)
            CentyHaptics.warning()
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

    // MARK: - Composer

    private func composerBanner(title: LocalizedStringKey, text: String, closeLabel: LocalizedStringKey, close: @escaping () -> Void) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.bold))
                    .foregroundColor(CentyColors.accentText)
                Text(text.isEmpty ? String(localized: "Вложение") : text)
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundColor(.secondary)
            }
            Spacer()
            Button(action: close) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundColor(.secondary)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel(closeLabel)
        }
        .padding(.leading, 16)
        .padding(.trailing, 4)
        .background(Color(uiColor: .secondarySystemBackground))
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            if canAttach && editingMessage == nil {
                Menu {
                    Button {
                        showsPhotoPicker = true
                    } label: {
                        Label("Фото", systemImage: "photo")
                    }
                    Button {
                        showsFileImporter = true
                    } label: {
                        Label("Файл", systemImage: "doc")
                    }
                } label: {
                    Image(systemName: "paperclip")
                        .font(.system(size: 20))
                        .foregroundColor(CentyColors.primaryBlue)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("Прикрепить")
                .accessibilityIdentifier("chat-attach")
            }

            TextField("Сообщение...", text: $inputText, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(uiColor: .secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .onChange(of: inputText) {
                    Task { await store.sendTypingIfNeeded() }
                }

            Button(action: {
                Task { await sendOrUpdateMessage() }
            }) {
                Image(systemName: editingMessage != nil ? "checkmark.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(inputIsBlank ? .gray : CentyColors.primaryBlue)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel(editingMessage != nil ? "Сохранить изменения" : "Отправить")
            .disabled(inputIsBlank || isSending)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color(uiColor: .systemBackground))
    }

    /// The composer clears only once the message is on disk (`delivery-state.md` §7.4); a refused
    /// write keeps the text, and a second tap meanwhile is ignored.
    private func sendOrUpdateMessage() async {
        let text = inputText
        guard !inputIsBlank, !isSending else { return }
        isSending = true
        defer { isSending = false }

        if let editing = editingMessage {
            if await store.edit(editing, text: text) || text == editing.text {
                editingMessage = nil
                inputText = ComposerText.afterSend(sent: text, current: inputText)
            }
        } else {
            let reply = replyingTo
            if await store.send(text: text, replyTo: reply) {
                // What was typed while the message was being stored stays in the field.
                inputText = ComposerText.afterSend(sent: text, current: inputText)
                replyingTo = nil
                CentyHaptics.light()
            } else {
                CentyHaptics.error()
            }
        }
    }

    private func handleSelectedPhoto() async {
        guard let item = selectedPhotoItem else { return }
        defer { selectedPhotoItem = nil }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            guard let picked = PhotoAttachment.make(from: data, contentType: item.supportedContentTypes.first) else {
                noticeText = String(localized: "Не удалось прочитать фото")
                return
            }
            let reply = replyingTo
            if await store.sendAttachment(picked, replyTo: reply) {
                replyingTo = nil
                CentyHaptics.success()
            } else {
                CentyHaptics.error()
            }
        } catch {
            Log.chat.error("Loading picked photo failed: \(error.localizedDescription, privacy: .public)")
            noticeText = String(localized: "Не удалось прочитать фото")
            CentyHaptics.error()
        }
    }

    private func handleImportedFile(_ result: Result<[URL], any Error>) async {
        guard case .success(let urls) = result, let url = urls.first else { return }
        // The picker's grant ends with this scope: the queue keeps its own private copy.
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let picked = PickedAttachment(source: .file(url), name: url.lastPathComponent, mimeType: type)
        let reply = replyingTo
        if await store.sendAttachment(picked, replyTo: reply) {
            replyingTo = nil
            CentyHaptics.success()
        } else {
            CentyHaptics.error()
        }
    }
}

/// The date between the messages of two days.
private struct DaySeparator: View {
    let date: Date

    var body: some View {
        Text(date, format: .dateTime.day().month(.wide).year())
            .environment(\.locale, Locale(identifier: "ru_RU"))
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Color(uiColor: .secondarySystemBackground), in: Capsule())
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A photo from the picker as a file to send: JPEG, PNG, GIF and WebP go as they are (the server
/// thumbnails them); anything else (HEIC) is converted to JPEG so the server's policy accepts it.
enum PhotoAttachment {
    static func make(from data: Data, contentType: UTType?, now: Date = Date()) -> PickedAttachment? {
        guard let image = UIImage(data: data) else { return nil }
        let width = Int(image.size.width * image.scale)
        let height = Int(image.size.height * image.scale)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd_HHmmss"
        let stamp = formatter.string(from: now)
        let passThrough: [(UTType, String, String)] = [(.jpeg, "jpg", "image/jpeg"), (.png, "png", "image/png"), (.gif, "gif", "image/gif"), (.webP, "webp", "image/webp")]
        if let contentType, let match = passThrough.first(where: { contentType.conforms(to: $0.0) }) {
            return PickedAttachment(source: .data(data), name: "IMG_\(stamp).\(match.1)", mimeType: match.2, width: width, height: height)
        }
        guard let jpeg = image.jpegData(compressionQuality: 0.85) else { return nil }
        return PickedAttachment(source: .data(jpeg), name: "IMG_\(stamp).jpg", mimeType: "image/jpeg", width: width, height: height)
    }
}
