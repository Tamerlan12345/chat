import SwiftUI
import UIKit

/// One message: the quote of a reply, its file, its text, its time and state (on the last bubble of a
/// group, or when it is edited or stalled), and — for a message that was not sent — why, with
/// «Повторить» / «Удалить». The long-press menu follows `MessageMenuPolicy`.
struct MessageBubbleView: View {
    @Environment(SessionStore.self) private var session

    let message: Message
    let isCurrentUser: Bool
    let showSenderHeader: Bool
    let showsMeta: Bool
    /// The download of this message's file (the tile shows its progress or failure).
    let transfer: AttachmentOpener.Transfer?
    let thumbnails: AttachmentThumbnails
    let onAction: (MessageMenuPolicy.Action, Message) -> Void
    let onOpenAttachment: (MessageAttachment) -> Void

    private var attachment: MessageAttachment? { MessageAttachment.of(message) }

    private var canEdit: Bool {
        guard isCurrentUser, !message.isDeleted, message.type == .text, message.sendState == nil else { return false }
        return ValidationRules.canEditOrDelete(
            createdAt: message.createdAt,
            windowMinutesStr: session.serverInfo.messageEditWindowMinutes,
            isSuperAdmin: session.currentUser?.permissions?.isAdmin ?? false,
            action: .edit
        )
    }

    private var canDelete: Bool {
        guard !message.isDeleted, message.sendState == nil else { return false }
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

    private var actions: [MessageMenuPolicy.Action] {
        MessageMenuPolicy.actions(for: message, isOwn: isCurrentUser, canEdit: canEdit, canDelete: canDelete)
    }

    private var foreground: Color { isCurrentUser ? CentyColors.senderBubbleText : CentyColors.receiverBubbleText }
    private var secondary: Color { isCurrentUser ? .white.opacity(0.78) : .secondary }

    var body: some View {
        HStack(alignment: .bottom) {
            if isCurrentUser { Spacer(minLength: 40) }
            VStack(alignment: isCurrentUser ? .trailing : .leading, spacing: 3) {
                if showSenderHeader && !isCurrentUser {
                    Text(message.senderName)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(CentyColors.accentText)
                        .padding(.horizontal, 4)
                }
                bubble
                    .contextMenu { menu }
                if message.sendState == .failed {
                    failedRow
                }
            }
            if !isCurrentUser { Spacer(minLength: 40) }
        }
    }

    // MARK: - Bubble

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            if message.isDeleted {
                Label("Сообщение удалено", systemImage: "trash")
                    .font(.subheadline.italic())
                    .foregroundStyle(secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            } else {
                if let quote = message.replyQuote {
                    replyQuote(quote)
                }
                if let attachment {
                    if attachment.isImage {
                        AttachmentImageView(attachment: attachment, thumbnails: thumbnails, upload: message.localUpload, transfer: transfer)
                            .onTapGesture { onOpenAttachment(attachment) }
                            .accessibilityAddTraits(.isButton)
                            .accessibilityLabel(Text("Фото \(attachment.name)"))
                            .accessibilityHint(Text("Открыть"))
                    } else {
                        AttachmentFileTile(attachment: attachment, upload: message.localUpload, transfer: transfer, isOutgoing: isCurrentUser)
                            .onTapGesture { onOpenAttachment(attachment) }
                    }
                }
                if message.type == .text && !message.text.isEmpty {
                    Text(message.text)
                        .font(.body)
                        .foregroundStyle(foreground)
                        .padding(.horizontal, 12)
                        .padding(.top, message.replyQuote == nil ? 8 : 2)
                        .padding(.bottom, showsMeta ? 0 : 8)
                        .textSelection(.disabled)
                }
                if showsMeta {
                    meta
                }
            }
        }
        .background(isCurrentUser ? CentyColors.senderBubble : CentyColors.receiverBubble)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .opacity(message.sendState == .queued ? 0.85 : 1)
    }

    private func replyQuote(_ quote: ReplyQuote) -> some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(isCurrentUser ? Color.white.opacity(0.8) : CentyColors.primaryBlue)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 1) {
                Text(quote.senderName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(isCurrentUser ? .white : CentyColors.accentText)
                Text(quote.text)
                    .font(.caption)
                    .foregroundStyle(secondary)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Ответ на сообщение \(quote.senderName): \(quote.text)"))
    }

    private var meta: some View {
        HStack(spacing: 4) {
            if message.updatedAt != nil {
                Text("изм.")
                    .font(.system(size: 9))
                    .foregroundStyle(secondary)
            }
            Text(message.createdAt, format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
                .font(.system(size: 10))
                .foregroundStyle(secondary)
                .environment(\.locale, Locale(identifier: "ru_RU"))
            if isCurrentUser {
                DeliveryStatusView(mark: DeliveryMark(message))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
        .padding(.top, message.type == .text ? 0 : 2)
    }

    private var failedRow: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Label {
                Text(message.failureReason.map { "Не отправлено: \($0)" } ?? String(localized: "Не отправлено"))
            } icon: {
                Image(systemName: "exclamationmark.circle.fill")
            }
            .font(.caption)
            .foregroundStyle(CentyColors.dangerText)
            .multilineTextAlignment(.trailing)
            HStack(spacing: 8) {
                Button("Повторить") { onAction(.retry, message) }
                    .accessibilityIdentifier("message-retry")
                Button("Удалить", role: .destructive) { onAction(.delete, message) }
                    .accessibilityIdentifier("message-discard")
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.bordered)
            .controlSize(.small)
            .frame(minHeight: 44)
        }
        .padding(.horizontal, 4)
    }

    // MARK: - Menu

    @ViewBuilder
    private var menu: some View {
        ForEach(actions, id: \.self) { action in
            switch action {
            case .reply:
                Button { onAction(.reply, message) } label: { Label("Ответить", systemImage: "arrowshape.turn.up.left") }
            case .copy:
                Button {
                    UIPasteboard.general.string = message.text
                    CentyHaptics.light()
                } label: { Label("Копировать", systemImage: "doc.on.doc") }
            case .edit:
                Button { onAction(.edit, message) } label: { Label("Редактировать", systemImage: "pencil") }
            case .retry:
                Button { onAction(.retry, message) } label: { Label("Повторить", systemImage: "arrow.clockwise") }
            case .delete:
                Button(role: .destructive) { onAction(.delete, message) } label: { Label("Удалить", systemImage: "trash") }
            case .report:
                Button { onAction(.report, message) } label: { Label("Пожаловаться", systemImage: "flag") }
            case .blockSender:
                if showSenderHeader {
                    Button(role: .destructive) { onAction(.blockSender, message) } label: { Label("Заблокировать автора", systemImage: "hand.raised") }
                }
            }
        }
    }
}

/// An image of a message: the local copy while it goes up, otherwise the server's thumbnail; the
/// placeholder keeps the picture's proportions so the list does not jump.
struct AttachmentImageView: View {
    let attachment: MessageAttachment
    let thumbnails: AttachmentThumbnails
    let upload: LocalUpload?
    let transfer: AttachmentOpener.Transfer?
    @State private var image: UIImage?

    private var aspectRatio: CGFloat {
        guard let width = attachment.width, let height = attachment.height, width > 0, height > 0 else { return 4 / 3 }
        return min(max(CGFloat(width) / CGFloat(height), 0.5), 2.5)
    }

    var body: some View {
        ZStack {
            Rectangle()
                .fill(Color(uiColor: .tertiarySystemFill))
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "photo")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }
            if let progress = upload?.progress {
                ProgressView(value: progress)
                    .progressViewStyle(.circular)
                    .tint(.white)
                    .padding(10)
                    .background(.black.opacity(0.35), in: Circle())
            }
        }
        .frame(width: 220)
        .aspectRatio(aspectRatio, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(4)
        .task(id: attachment) { await load() }
    }

    private func load() async {
        if let local = attachment.localFile ?? upload?.fileURL {
            image = await Task.detached { UIImage(contentsOfFile: local.path)?.preparingThumbnail(of: CGSize(width: 480, height: 480)) }.value
            return
        }
        guard let id = attachment.fileId else { return }
        if let data = await thumbnails.data(for: id) {
            image = UIImage(data: data)
        }
    }
}

/// A file of a message: its kind, name and size; while it goes up or down, its progress; when its
/// download failed, why.
struct AttachmentFileTile: View {
    let attachment: MessageAttachment
    let upload: LocalUpload?
    let transfer: AttachmentOpener.Transfer?
    let isOutgoing: Bool

    private var secondary: Color { isOutgoing ? .white.opacity(0.8) : .secondary }

    private var failed: Bool {
        if case .failed = transfer { return true }
        return false
    }

    private var detail: String {
        switch transfer {
        case .running(let progress?):
            return String(localized: "Загрузка \(Int(progress * 100))%")
        case .running(nil):
            return String(localized: "Загрузка…")
        case .failed(let reason):
            return reason
        default:
            if let progress = upload?.progress { return String(localized: "Отправка \(Int(progress * 100))%") }
            return attachment.size.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? ""
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle()
                    .fill(isOutgoing ? Color.white.opacity(0.2) : CentyColors.primarySoft)
                    .frame(width: 40, height: 40)
                if case .running(let progress) = transfer {
                    ProgressView(value: progress ?? 0)
                        .progressViewStyle(.circular)
                        .tint(isOutgoing ? .white : CentyColors.primaryBlue)
                } else {
                    Image(systemName: "doc.fill")
                        .foregroundStyle(isOutgoing ? .white : CentyColors.primaryBlue)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(isOutgoing ? .white : CentyColors.receiverBubbleText)
                    .lineLimit(2)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(failed && !isOutgoing ? CentyColors.dangerText : secondary)
                        .lineLimit(2)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text("Открыть файл"))
    }
}
