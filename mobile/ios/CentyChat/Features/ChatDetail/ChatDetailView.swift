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

/// The rows of one day: the sticky date pill over them.
private struct DaySection: Identifiable {
    let id: String
    let date: Date
    var rows: [ChatRow]

    static func of(_ rows: [ChatRow]) -> [DaySection] {
        var sections: [DaySection] = []
        for row in rows {
            if row.startsDay || sections.isEmpty {
                sections.append(DaySection(id: "day-" + row.id, date: row.message.createdAt, rows: []))
            }
            sections[sections.count - 1].rows.append(row)
        }
        return sections
    }
}

/// The chat screen bound to one `ChatStore` (design brief «Chat», «UI layer v2»):
/// - the L2 canvas, the tab bar hidden, the top bar flat at rest and lifting on scroll (system);
/// - the header: avatar and name (a tap opens the person's card over the chat), presence in
///   `textDim` or «печатает…» in `accentText`;
/// - grouped bubbles (gap 2 inside a group, 8 between groups), sticky quiet date pills;
/// - the composer on the L3 bar material in `.safeAreaInset(edge: .bottom)`, glued to the keyboard,
///   the list anchored at the bottom and dismissing the keyboard interactively — no manual offsets;
/// - "the message lands": an own bubble lifts in from the composer (spring, a fade with Reduce Motion),
///   incoming ones fade and rise 8 pt; scrolled up, «↓ N новых» instead of a jump.
private struct ChatDetailContent: View {
    @Environment(SessionStore.self) private var session
    @Environment(ConversationsStore.self) private var conversations
    @Environment(CallStore.self) private var calls
    @Environment(AccountStore.self) private var account
    @Environment(NavigationRouter.self) private var router: NavigationRouter?
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
    @State private var copied = TransientFlag()
    /// The newest message is on screen (the list follows it); scrolled up, new ones are counted.
    @State private var isAtBottom = true
    @State private var newWhileAway = 0
    @FocusState private var composerFocused: Bool

    // Вложения
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var showsPhotoPicker = false
    @State private var showsFileImporter = false

    private static let bottomID = "chat-bottom"

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

    /// The per-person menu and the card exist only in a dialog with someone else.
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

    /// Live presence of the peer (the inbox store follows `user_status_changed`).
    private var peerStatus: UserStatus? {
        guard conversationType == .direct else { return nil }
        return conversations.directConversations.first(where: { $0.userId == targetId })?.status ?? status
    }

    var body: some View {
        messageList
            .overlay(alignment: .bottom) {
                if copied.isOn {
                    HUDCapsule(text: "Скопировано")
                        .padding(.bottom, 12)
                        .transition(.opacity)
                        .accessibilityIdentifier("chat-copied")
                }
            }
            .animation(.easeOut(duration: CentyMotion.base), value: copied.isOn)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                composer
            }
            .background(CentyColors.canvas.ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            // The chat takes the screen: no tab bar under the composer.
            .toolbar(.hidden, for: .tabBar)
            .toolbar { toolbar }
            .connectionBanner()
            .overlay(alignment: .top) {
                if let noticeText {
                    NoticeToast(text: noticeText) {
                        dismissNotice()
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(CentyMotion.or(CentyMotion.easeOut(CentyMotion.slow), reduceMotion: reduceMotion), value: noticeText)
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
                    // A gone hit leaves a notice instead of a silent jump to the end.
                    let found = await store.open(at: target)
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
                if let notice { show(notice: notice.text) }
            }
            .onChange(of: opener.notice) { _, notice in
                if let notice {
                    show(notice: notice)
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
                Button("Закрыть", role: .cancel) {}
            } message: {
                Text(safetyError ?? "")
            }
    }

    // MARK: - Message list

    private var messageList: some View {
        let rows = self.rows
        let sections = DaySection.of(rows)
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    if !store.reachedStart && !rows.isEmpty {
                        ProgressView()
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .accessibilityLabel(Text("Загрузка более ранних сообщений"))
                            .onAppear { Task { await store.loadOlder() } }
                    }
                    if rows.isEmpty {
                        emptyHistory
                    }
                    ForEach(sections) { section in
                        Section {
                            ForEach(section.rows) { row in
                                bubbleRow(row, firstOfDay: row.id == section.rows.first?.id)
                            }
                        } header: {
                            DateSeparator(date: section.date)
                        }
                    }
                    if typingText != nil {
                        HStack {
                            TypingBubble()
                            Spacer(minLength: 48)
                        }
                        .padding(.top, 8)
                        .transition(.opacity)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomID)
                        .onAppear {
                            isAtBottom = true
                            newWhileAway = 0
                        }
                        .onDisappear { isAtBottom = false }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .animation(CentyMotion.lift(reduceMotion: reduceMotion), value: rows.last?.id)
                .animation(CentyMotion.or(CentyMotion.easeOut(), reduceMotion: reduceMotion), value: typingText != nil)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: store.messages.last?.rowID) { old, last in
                // Opening at a search hit: the list waits for the history around it.
                guard isFollowingBottom, let last else { return }
                let isOwn = store.messages.last?.senderId == session.currentUser?.id
                if isAtBottom || isOwn || old == nil {
                    withAnimation(CentyMotion.or(CentyMotion.decelerate(), reduceMotion: reduceMotion)) {
                        proxy.scrollTo(Self.bottomID, anchor: .bottom)
                    }
                    _ = last
                    newWhileAway = 0
                } else {
                    newWhileAway += 1
                }
            }
            .onChange(of: scrollRequest) { _, request in
                guard let request else { return }
                proxy.scrollTo(request.rowID, anchor: request.pulses ? .center : .bottom)
                if request.pulses { pulse(request.rowID) }
            }
            .onChange(of: composerFocused) { _, focused in
                // The keyboard rises: the conversation follows only if the reader was at the end.
                guard focused, isAtBottom else { return }
                withAnimation(CentyMotion.or(CentyMotion.easeOut(), reduceMotion: reduceMotion)) {
                    proxy.scrollTo(Self.bottomID, anchor: .bottom)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !isAtBottom && !rows.isEmpty {
                    JumpToLatestPill(newCount: newWhileAway) {
                        withAnimation(CentyMotion.or(CentyMotion.decelerate(), reduceMotion: reduceMotion)) {
                            proxy.scrollTo(Self.bottomID, anchor: .bottom)
                        }
                        newWhileAway = 0
                    }
                    .padding(.trailing, 12)
                    .padding(.bottom, 8)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                }
            }
            .animation(CentyMotion.or(.spring(response: 0.3, dampingFraction: 0.8), reduceMotion: reduceMotion), value: isAtBottom)
        }
    }

    @ViewBuilder
    private var emptyHistory: some View {
        switch store.loadState {
        case .idle, .loading:
            VStack(spacing: 10) {
                SkeletonBubble(width: 200)
                SkeletonBubble(isOwn: true, width: 150)
                SkeletonBubble(width: 230)
                SkeletonBubble(isOwn: true, width: 120)
            }
            .padding(.top, 16)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Загрузка"))
        case .failed(let message):
            VStack(spacing: 12) {
                SpotIllustrationView(kind: .offline)
                Text("Не удалось загрузить переписку")
                    .font(.headline)
                    .foregroundStyle(CentyColors.textStrong)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textSecondary)
                    .multilineTextAlignment(.center)
                EmptyStateAction(title: "Повторить", systemImage: "arrow.clockwise") {
                    Task { await store.load() }
                }
            }
            .padding(.top, 64)
            .padding(.horizontal, 24)
        case .loaded:
            VStack(spacing: 12) {
                SpotIllustrationView(kind: conversationType == .channel ? .channel : .bubbles)
                Text(conversationType == .channel ? "В канале пока тихо" : "Пока нет сообщений")
                    .font(.headline)
                    .foregroundStyle(CentyColors.textStrong)
                Text("Напишите первое сообщение — оно появится здесь.")
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 64)
            .padding(.horizontal, 24)
        }
    }

    private func bubbleRow(_ row: ChatRow, firstOfDay: Bool) -> some View {
        let message = row.message
        let isOwn = message.senderId == session.currentUser?.id
        let insertion: AnyTransition = reduceMotion
            ? .opacity
            : (isOwn
                ? .scale(scale: 0.96, anchor: .bottomTrailing).combined(with: .opacity).combined(with: .offset(y: 12))
                : .opacity.combined(with: .offset(y: 8)))
        return MessageBubbleView(
            message: message,
            isCurrentUser: isOwn,
            showSenderHeader: conversationType == .channel && row.startsGroup,
            showsMeta: row.showsMeta,
            startsGroup: row.startsGroup,
            endsGroup: row.endsGroup,
            transfer: MessageAttachment.of(message)?.fileId.flatMap { opener.transfers[$0] },
            thumbnails: thumbnails,
            onAction: handle,
            onOpenAttachment: { opener.open($0) },
            onCopied: { copied.show(for: .milliseconds(1_500)) }
        )
        // Rhythm: 8 between groups, 2 inside a group.
        .padding(.top, firstOfDay ? 2 : (row.startsGroup ? 8 : 2))
        // The search hit pulses once the chat scrolled to it.
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(CentyColors.primarySoft)
                .padding(-4)
                .opacity(pulsingRowID == row.id ? 1 : 0)
        )
        .swipeToReply(isEnabled: !message.isDeleted && message.sendState == nil) {
            reply(to: message)
        }
        .transition(.asymmetric(insertion: insertion, removal: .opacity))
        .id(row.id)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            header
        }

        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 0) {
                if isCallingAllowed {
                    Button {
                        Task {
                            let colleague = PublicUser(id: targetId, username: "", fullName: title, avatarUrl: avatarUrl, status: peerStatus ?? .online)
                            await calls.startOutgoingCall(targetUser: colleague)
                        }
                    } label: {
                        Image(systemName: "phone")
                            .font(.body.weight(.semibold))
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Позвонить")
                }
                if showsPersonMenu {
                    Menu {
                        Button {
                            openCard()
                        } label: {
                            Label("Карточка сотрудника", systemImage: "person.crop.circle")
                        }
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
                            .font(.body.weight(.semibold))
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Действия с пользователем")
                    .accessibilityIdentifier("chat-person-menu")
                }
            }
            .foregroundStyle(CentyColors.accentText)
        }
    }

    /// Avatar, name and presence (or «печатает…»); in a dialog a tap opens the person's card.
    @ViewBuilder
    private var header: some View {
        let content = HStack(spacing: 8) {
            if conversationType == .direct {
                AvatarView(name: title, avatarUrl: avatarUrl, size: 32)
            } else {
                ChannelAvatar(size: 32)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(CentyColors.textStrong)
                    .lineLimit(1)
                if let typingText {
                    TypingIndicatorView(text: typingText)
                        .transition(.opacity)
                } else if let peerStatus {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(peerStatus.color)
                            .frame(width: 6, height: 6)
                            .accessibilityHidden(true)
                        Text(peerStatus.displayName)
                            .font(.caption)
                            .foregroundStyle(CentyColors.textDim)
                    }
                    .transition(.opacity)
                }
            }
            .animation(CentyMotion.or(CentyMotion.easeOut(), reduceMotion: reduceMotion), value: typingText)
        }
        if showsPersonMenu {
            Button(action: openCard) {
                content
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityHint(Text("Открыть карточку сотрудника"))
            .accessibilityIdentifier("chat-header-avatar")
        } else {
            content
                .accessibilityElement(children: .combine)
        }
    }

    /// The person's card over this chat; its «Написать» comes back here.
    private func openCard() {
        router?.push(.person(PersonRoute(id: targetId, name: title, avatarUrl: avatarUrl)))
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

    // MARK: - Notices

    /// A short notice under the top bar (never an alert for a non-blocking message); VoiceOver reads it.
    private func show(notice text: String) {
        noticeText = text
        UIAccessibility.post(notification: .announcement, argument: text)
        Task {
            try? await Task.sleep(for: .seconds(4))
            if noticeText == text { dismissNotice() }
        }
    }

    private func dismissNotice() {
        noticeText = nil
        store.dismissNotice()
    }

    // MARK: - Message actions

    private func reply(to message: Message) {
        editingMessage = nil
        replyingTo = message
        composerFocused = true
    }

    private func handle(_ action: MessageMenuPolicy.Action, _ message: Message) {
        switch action {
        case .reply:
            reply(to: message)
        case .copy:
            break
        case .edit:
            replyingTo = nil
            editingMessage = message
            inputText = message.text
            composerFocused = true
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

    /// The L3 plane: the bar material with a hairline, the edit/reply banner, the blocked banner and
    /// the filled field (no outline) with the attach button that morphs into send.
    private var composer: some View {
        VStack(spacing: 0) {
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
                        .foregroundStyle(CentyColors.dangerText)
                        .accessibilityHidden(true)
                    Text("Вы заблокировали этого пользователя. Его сообщения скрыты.")
                        .font(.footnote)
                        .foregroundStyle(CentyColors.textSecondary)
                    Spacer(minLength: 8)
                    Button("Разблокировать") { unblockPeer() }
                        .buttonStyle(CentyLinkButtonStyle())
                        .font(.footnote)
                        .accessibilityIdentifier("chat-unblock-banner")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
                .background(CentyColors.dangerSoft)
                .accessibilityElement(children: .contain)
            }

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Сообщение...", text: $inputText, axis: .vertical)
                    .lineLimit(1...6)
                    .font(.body)
                    .foregroundStyle(CentyColors.textMain)
                    .focused($composerFocused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .frame(minHeight: 44)
                    .background(CentyColors.sunken, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .onChange(of: inputText) {
                        Task { await store.sendTypingIfNeeded() }
                    }
                trailingButton
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .animation(CentyMotion.or(.spring(response: 0.25, dampingFraction: 0.85), reduceMotion: reduceMotion), value: inputText.isEmpty)
        }
        .background(.bar)
        .overlay(alignment: .top) {
            Rectangle().fill(CentyColors.border).frame(height: 1)
        }
    }

    /// Attach while the field is empty, send (a 40-pt `primary` circle) once there is text: the two
    /// morph with a scale and a crossfade (150 ms).
    @ViewBuilder
    private var trailingButton: some View {
        ZStack {
            if editingMessage == nil && inputText.isEmpty && canAttach {
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
                        .font(.title3.weight(.medium))
                        .foregroundStyle(CentyColors.accentText)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Прикрепить")
                .accessibilityIdentifier("chat-attach")
                .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
            } else {
                Button {
                    Task { await sendOrUpdateMessage() }
                } label: {
                    Image(systemName: editingMessage != nil ? "checkmark" : "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(inputIsBlank ? CentyColors.textDim : CentyColors.onPrimary)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(inputIsBlank ? CentyColors.sunken : CentyColors.primaryBlue))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle(reduceMotion: reduceMotion))
                .accessibilityLabel(editingMessage != nil ? "Сохранить изменения" : "Отправить")
                .disabled(inputIsBlank || isSending)
                .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.15), value: inputText.isEmpty)
    }

    private func composerBanner(title: LocalizedStringKey, text: String, closeLabel: LocalizedStringKey, close: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 1)
                .fill(CentyColors.primaryBlue)
                .frame(width: 2)
                .padding(.vertical, 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(CentyColors.accentText)
                Text(text.isEmpty ? String(localized: "Вложение") : text)
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundStyle(CentyColors.textSecondary)
            }
            Spacer()
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(CentyColors.textDim)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel(closeLabel)
        }
        .padding(.leading, 16)
        .padding(.trailing, 4)
        .transition(.opacity)
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
                show(notice: String(localized: "Не удалось прочитать фото"))
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
            show(notice: String(localized: "Не удалось прочитать фото"))
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

/// A short notice under the top bar (L3: elevated tone with a hairline), dismissed by a tap.
struct NoticeToast: View {
    let text: String
    let dismiss: () -> Void

    var body: some View {
        Button(action: dismiss) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "info.circle.fill")
                    .foregroundStyle(CentyColors.accentText)
                    .accessibilityHidden(true)
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(CentyColors.textMain)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(CentyColors.elevated))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(CentyColors.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("Скрыть"))
        .accessibilityIdentifier("chat-notice")
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

#if DEBUG
#Preview("Чат") {
    NavigationStack {
        ChatDetailView(conversationType: .direct, targetId: 2, title: "Боб Тестов", status: .online)
    }
    .previewEnvironment()
}
#endif
