import SwiftUI

/// Пузырь сообщения в переписке с поддержкой форматирования, вложений и контекстного меню
public struct MessageBubbleView: View {
    @Environment(SessionStore.self) private var session

    public let message: Message
    public let isCurrentUser: Bool
    public let showSenderHeader: Bool
    public let onEdit: (Message) -> Void
    public let onDelete: (Message) -> Void

    public init(
        message: Message,
        isCurrentUser: Bool,
        showSenderHeader: Bool = false,
        onEdit: @escaping (Message) -> Void,
        onDelete: @escaping (Message) -> Void
    ) {
        self.message = message
        self.isCurrentUser = isCurrentUser
        self.showSenderHeader = showSenderHeader
        self.onEdit = onEdit
        self.onDelete = onDelete
    }

    private var formattedTime: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: message.createdAt)
    }

    private var canEdit: Bool {
        guard isCurrentUser, !message.isDeleted, message.type == .text else { return false }
        let isSuperAdmin = session.currentUser?.permissions?.isAdmin ?? false
        return ValidationRules.canEditOrDelete(
            createdAt: message.createdAt,
            windowMinutesStr: session.serverInfo.messageEditWindowMinutes,
            isSuperAdmin: isSuperAdmin,
            action: .edit
        )
    }

    private var canDelete: Bool {
        guard !message.isDeleted else { return false }
        let isSuperAdmin = session.currentUser?.permissions?.isAdmin ?? false
        if isSuperAdmin { return true }
        guard isCurrentUser else { return false }
        return ValidationRules.canEditOrDelete(
            createdAt: message.createdAt,
            windowMinutesStr: session.serverInfo.messageDeleteWindowMinutes,
            isSuperAdmin: isSuperAdmin,
            action: .delete
        )
    }

    public var body: some View {
        HStack {
            if isCurrentUser { Spacer(minLength: 40) }

            VStack(alignment: isCurrentUser ? .trailing : .leading, spacing: 3) {
                // Имя автора в канале (если входящее)
                if showSenderHeader && !isCurrentUser {
                    Text(message.senderName)
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(CentyColors.primaryBlue)
                        .padding(.horizontal, 4)
                }

                VStack(alignment: .trailing, spacing: 4) {
                    if message.isDeleted {
                        HStack(spacing: 4) {
                            Image(systemName: "trash")
                                .font(.caption)
                            Text("Сообщение удалено")
                                .font(.subheadline.italic())
                        }
                        .foregroundColor(isCurrentUser ? .white.opacity(0.8) : .secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    } else {
                        // Вложение-картинка
                        if message.type == .image, let meta = message.metadata, let urlStr = meta.url {
                            if let url = session.attachmentURL(for: urlStr) {
                                AsyncImage(url: url) { phase in
                                    switch phase {
                                    case .success(let image):
                                        image.resizable()
                                            .scaledToFit()
                                            .frame(maxWidth: 240, maxHeight: 240)
                                            .clipShape(RoundedRectangle(cornerRadius: 12))
                                    default:
                                        ProgressView()
                                            .frame(width: 120, height: 120)
                                    }
                                }
                            }
                        }

                        // Вложение-файл
                        if message.type == .file, let meta = message.metadata {
                            HStack(spacing: 8) {
                                Image(systemName: "doc.fill")
                                    .font(.title3)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(message.fileOriginalName ?? meta.fileName ?? String(localized: "Документ"))
                                        .font(.subheadline.weight(.medium))
                                        .lineLimit(1)
                                    if let size = meta.fileSize {
                                        Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
                                            .font(.caption2)
                                            .foregroundColor(isCurrentUser ? .white.opacity(0.8) : .secondary)
                                    }
                                }
                            }
                            .padding(.horizontal, 8)
                            .padding(.top, 4)
                        }

                        // Текст сообщения
                        if !message.text.isEmpty && message.type != .image {
                            Text(message.text)
                                .font(.body)
                                .foregroundColor(isCurrentUser ? CentyColors.senderBubbleText : CentyColors.receiverBubbleText)
                                .padding(.horizontal, 12)
                                .padding(.top, 8)
                                .padding(.bottom, 2)
                        }

                        // Время и статус галочек
                        HStack(spacing: 4) {
                            if message.updatedAt != nil {
                                Text("изм.")
                                    .font(.system(size: 9))
                                    .foregroundColor(isCurrentUser ? .white.opacity(0.7) : .secondary)
                            }

                            Text(formattedTime)
                                .font(.system(size: 10))
                                .foregroundColor(isCurrentUser ? .white.opacity(0.75) : .secondary)

                            if isCurrentUser {
                                DeliveryStatusView(status: message.deliveryStatus, isOutgoing: true)
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.bottom, 6)
                    }
                }
                .background(isCurrentUser ? CentyColors.senderBubble : CentyColors.receiverBubble)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .contextMenu {
                    if !message.isDeleted {
                        Button(action: {
                            UIPasteboard.general.string = message.text
                            CentyHaptics.light()
                        }) {
                            Label("Скопировать текст", systemImage: "doc.on.doc")
                        }

                        if canEdit {
                            Button(action: {
                                onEdit(message)
                            }) {
                                Label("Редактировать", systemImage: "pencil")
                            }
                        }

                        if canDelete {
                            Button(role: .destructive, action: {
                                onDelete(message)
                            }) {
                                Label("Удалить", systemImage: "trash")
                            }
                        }
                    }
                }
            }

            if !isCurrentUser { Spacer(minLength: 40) }
        }
    }
}
