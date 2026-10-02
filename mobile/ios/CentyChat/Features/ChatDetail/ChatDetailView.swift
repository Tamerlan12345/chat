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

    public init(
        conversationType: ConversationType,
        targetId: Int64,
        title: String,
        avatarUrl: String? = nil,
        status: UserStatus? = nil
    ) {
        self.conversationType = conversationType
        self.targetId = targetId
        self.title = title
        self.avatarUrl = avatarUrl
        self.status = status
    }

    public var body: some View {
        ChatDetailContent(
            store: container.chats.store(for: ConversationKey(type: conversationType, targetId: targetId)),
            title: title,
            avatarUrl: avatarUrl,
            status: status
        )
    }
}

/// The chat screen bound to one `ChatStore`.
private struct ChatDetailContent: View {
    @Environment(SessionStore.self) private var session
    @Environment(ConversationsStore.self) private var conversations
    @Environment(CallStore.self) private var calls

    let store: ChatStore
    let title: String
    let avatarUrl: String?
    let status: UserStatus?

    @State private var inputText: String = ""
    @State private var editingMessage: Message? = nil

    // Вложения
    @State private var selectedPhotoItem: PhotosPickerItem? = nil

    private var conversationType: ConversationType { store.conversation.type }
    private var targetId: Int64 { store.conversation.targetId }

    private var typingText: String? {
        conversations.typingUsers[ConversationsStore.typingKey(for: store.conversation)]
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
                        ForEach(store.messages) { message in
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
                                }
                            )
                            .id(message.id)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .background(CentyColors.chatBackground)
                .onChange(of: store.messages.count) {
                    if let last = store.messages.last {
                        withAnimation {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
                .onAppear {
                    if let last = store.messages.last {
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
            store.setVisible(true)
        }
        .onDisappear {
            store.setVisible(false)
        }
        .task {
            await store.load()
            await store.markAsRead()
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
