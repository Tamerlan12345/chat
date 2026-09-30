import SwiftUI
import PhotosUI

/// Детальный экран диалога или канала с поддержкой сообщений, вложений, тайпинга и звонков
public struct ChatDetailView: View {
    @Environment(AppState.self) private var appState
    
    public let conversationType: ConversationType
    public let targetId: Int64
    public let title: String
    public let avatarUrl: String?
    public let status: UserStatus?
    
    @State private var messages: [Message] = []
    @State private var inputText: String = ""
    @State private var isLoading: Bool = false
    @State private var editingMessage: Message? = nil
    
    // Вложения
    @State private var selectedPhotoItem: PhotosPickerItem? = nil
    @State private var showAttachmentActionSheet: Bool = false
    @State private var isUploadingAttachment: Bool = false
    
    // Typing throttling
    @State private var lastTypingSent: Date = Date.distantPast
    
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
    
    private var typingKey: String {
        "\(conversationType.rawValue)_\(targetId)"
    }
    
    private var isCallingAllowed: Bool {
        conversationType == .direct && (appState.currentUser?.permissions?.canCall ?? true)
    }
    
    public var body: some View {
        VStack(spacing: 0) {
            // Список сообщений
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(messages) { message in
                            MessageBubbleView(
                                message: message,
                                isCurrentUser: message.senderId == appState.currentUser?.id,
                                showSenderHeader: conversationType == .channel,
                                onEdit: { msg in
                                    editingMessage = msg
                                    inputText = msg.text
                                },
                                onDelete: { msg in
                                    Task { await deleteMessage(msg) }
                                }
                            )
                            .id(message.id)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .background(CentyColors.chatBackground)
                .onChange(of: messages.count) {
                    if let last = messages.last {
                        withAnimation {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
                .onAppear {
                    if let last = messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            
            // Индикатор набора текста
            if let typingUser = appState.typingUsers[typingKey] {
                HStack {
                    TypingIndicatorView(text: typingUser)
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
                                await appState.startOutgoingCall(targetUser: colleague)
                            }
                        }) {
                            Image(systemName: "phone.fill")
                                .foregroundColor(CentyColors.primaryBlue)
                        }
                    }
                }
            }
        }
        .task {
            await loadMessages()
            markAsRead()
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
                    sendTypingIndicatorIfNeeded()
                }
            
            // Кнопка отправки
            Button(action: {
                Task { await sendOrUpdateMessage() }
            }) {
                Image(systemName: editingMessage != nil ? "checkmark.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(inputText.trimmingCharacters(in: .whitespaces).isEmpty ? .gray : CentyColors.primaryBlue)
            }
            .disabled(inputText.trimmingCharacters(in: .whitespaces).isEmpty || isUploadingAttachment)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemBackground))
    }
    
    // MARK: - Actions
    
    private func loadMessages() async {
        isLoading = true
        defer { isLoading = false }
        
        do {
            let loaded = try await APIClient.shared.getMessages(conversationType: conversationType, targetId: targetId)
            self.messages = loaded
        } catch {
            print("[ChatDetailView] Error loading messages: \(error)")
        }
    }
    
    private func markAsRead() {
        Task {
            await WebSocketClient.shared.send(clientMessage: .markRead(conversationType: conversationType, targetId: targetId))
            if conversationType == .direct {
                if let idx = appState.directConversations.firstIndex(where: { $0.userId == targetId }) {
                    appState.directConversations[idx].unreadCount = 0
                }
            } else {
                if let idx = appState.channels.firstIndex(where: { $0.id == targetId }) {
                    appState.channels[idx].unreadCount = 0
                }
            }
        }
    }
    
    private func sendTypingIndicatorIfNeeded() {
        let now = Date()
        guard now.timeIntervalSince(lastTypingSent) > 2.0 else { return }
        lastTypingSent = now
        Task {
            await WebSocketClient.shared.send(clientMessage: .typing(conversationType: conversationType, targetId: targetId, isTyping: true))
        }
    }
    
    private func sendOrUpdateMessage() async {
        let text = inputText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        
        if let editing = editingMessage {
            // Редактирование
            await WebSocketClient.shared.send(clientMessage: .editMessage(messageId: editing.id, text: text))
            if let idx = messages.firstIndex(where: { $0.id == editing.id }) {
                messages[idx].text = text
                messages[idx].updatedAt = Date()
            }
            editingMessage = nil
            inputText = ""
            CentyHaptics.light()
        } else {
            // Отправка нового сообщения
            inputText = ""
            await WebSocketClient.shared.send(clientMessage: .sendMessage(
                conversationType: conversationType,
                targetId: targetId,
                text: text,
                msgType: .text
            ))
            
            // Оптимистичное добавление в локальный список
            let tempMsg = Message(
                id: Int64(Date().timeIntervalSince1970 * 1000),
                conversationType: conversationType,
                targetId: targetId,
                senderId: appState.currentUser?.id ?? 0,
                text: text,
                type: .text,
                createdAt: Date(),
                senderName: appState.currentUser?.fullName ?? "Я",
                deliveryStatus: .sent
            )
            messages.append(tempMsg)
            CentyHaptics.light()
        }
    }
    
    private func deleteMessage(_ msg: Message) async {
        await WebSocketClient.shared.send(clientMessage: .deleteMessage(messageId: msg.id))
        if let idx = messages.firstIndex(where: { $0.id == msg.id }) {
            messages[idx].isDeleted = true
            messages[idx].text = ""
        }
        CentyHaptics.warning()
    }
    
    private func handleSelectedPhoto() async {
        guard let item = selectedPhotoItem else { return }
        isUploadingAttachment = true
        defer {
            isUploadingAttachment = false
            selectedPhotoItem = nil
        }
        
        do {
            if let data = try await item.loadTransferable(type: Data.self) {
                let fileName = "photo_\(Int(Date().timeIntervalSince1970)).jpg"
                let uploadRes = try await APIClient.shared.uploadFile(fileData: data, fileName: fileName, mimeType: "image/jpeg")
                
                let metadata = MessageMetadata(
                    fileId: uploadRes.id,
                    fileName: uploadRes.originalName,
                    fileSize: uploadRes.fileSize,
                    mimeType: uploadRes.mimeType,
                    url: uploadRes.url
                )
                
                await WebSocketClient.shared.send(clientMessage: .sendMessage(
                    conversationType: conversationType,
                    targetId: targetId,
                    text: fileName,
                    msgType: .image,
                    metadata: metadata
                ))
                
                CentyHaptics.success()
            }
        } catch {
            print("[ChatDetailView] Error uploading photo: \(error)")
            CentyHaptics.error()
        }
    }
}
