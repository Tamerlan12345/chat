import SwiftUI
import UIKit

/// One message (design brief component 4, desktop `.chat-message-bubble`): own on the right in
/// `primary-soft` with a `primary-line` hairline and `accentText`, incoming on the left on `card` with
/// a `border` hairline and `textMain`. Group radii with the 2-pt tail only on the first bubble; the
/// reply quote with a 2-pt indigo bar; the time and state inside the bubble, on the last line when it
/// fits, else on a line of its own; a message that was not sent says why with «Повторить / Удалить».
/// The long-press menu is the native context menu (the bubble lifts), following `MessageMenuPolicy`.
struct MessageBubbleView: View {
    @Environment(SessionStore.self) private var session

    let message: Message
    let isCurrentUser: Bool
    let showSenderHeader: Bool
    let showsMeta: Bool
    let startsGroup: Bool
    let endsGroup: Bool
    /// The download of this message's file (the tile shows its progress or failure).
    let transfer: AttachmentOpener.Transfer?
    let thumbnails: AttachmentThumbnails
    let onAction: (MessageMenuPolicy.Action, Message) -> Void
    let onOpenAttachment: (MessageAttachment) -> Void
    let onCopied: () -> Void

    init(
        message: Message,
        isCurrentUser: Bool,
        showSenderHeader: Bool,
        showsMeta: Bool,
        startsGroup: Bool = true,
        endsGroup: Bool = true,
        transfer: AttachmentOpener.Transfer?,
        thumbnails: AttachmentThumbnails,
        onAction: @escaping (MessageMenuPolicy.Action, Message) -> Void,
        onOpenAttachment: @escaping (MessageAttachment) -> Void,
        onCopied: @escaping () -> Void = {}
    ) {
        self.message = message
        self.isCurrentUser = isCurrentUser
        self.showSenderHeader = showSenderHeader
        self.showsMeta = showsMeta
        self.startsGroup = startsGroup
        self.endsGroup = endsGroup
        self.transfer = transfer
        self.thumbnails = thumbnails
        self.onAction = onAction
        self.onOpenAttachment = onOpenAttachment
        self.onCopied = onCopied
    }

    private var attachment: MessageAttachment? { MessageAttachment.of(message) }

    private var corners: BubbleCorners {
        .of(isOwn: isCurrentUser, startsGroup: startsGroup, endsGroup: endsGroup)
    }

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

    private var foreground: Color { isCurrentUser ? CentyColors.accentText : CentyColors.textMain }

    private var hasText: Bool { message.type == .text && !message.text.isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if isCurrentUser { Spacer(minLength: 48) }
            VStack(alignment: isCurrentUser ? .trailing : .leading, spacing: 4) {
                if showSenderHeader && !isCurrentUser {
                    Text(message.senderName)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(CentyColors.accentText)
                        .padding(.horizontal, 4)
                }
                bubble
                    .contentShape(.contextMenuPreview, corners.shape)
                    .contextMenu { menu }
                if message.sendState == .failed {
                    failedRow
                }
            }
            if !isCurrentUser { Spacer(minLength: 48) }
        }
    }

    // MARK: - Bubble

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 0) {
            if message.isDeleted {
                HStack(spacing: 8) {
                    Label("Сообщение удалено", systemImage: "trash")
                        .font(.subheadline.italic())
                        .foregroundStyle(CentyColors.textDim)
                    if showsMeta { meta }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            } else {
                if let quote = message.replyQuote {
                    replyQuote(quote)
                }
                if let attachment {
                    if attachment.isImage {
                        AttachmentImageView(attachment: attachment, thumbnails: thumbnails, upload: message.localUpload, transfer: transfer)
                            // A photo without a caption carries its time on itself: the bubble
                            // hugs the picture instead of a full-width time row.
                            .overlay(alignment: .bottomTrailing) {
                                if showsMeta && !hasText {
                                    meta
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(Capsule().fill(Color.black.opacity(0.5)))
                                        .environment(\.colorScheme, .dark)
                                        .padding(10)
                                }
                            }
                            .onTapGesture { onOpenAttachment(attachment) }
                            .accessibilityAddTraits(.isButton)
                            .accessibilityLabel(Text("Фото \(attachment.name)"))
                            .accessibilityHint(Text("Открыть"))
                    } else {
                        AttachmentFileTile(attachment: attachment, upload: message.localUpload, transfer: transfer, isOutgoing: isCurrentUser)
                            .onTapGesture { onOpenAttachment(attachment) }
                    }
                }
                if hasText {
                    textAndMeta
                        .padding(.horizontal, 12)
                        .padding(.top, message.replyQuote == nil ? 8 : 4)
                        .padding(.bottom, 8)
                } else if showsMeta && attachment?.isImage != true {
                    meta
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                }
            }
        }
        .modifier(BubbleBackground(corners: corners, isOwn: isCurrentUser))
        .opacity(message.sendState == .queued ? 0.88 : 1)
    }

    /// The time on the last line when it fits there, else on its own line under the text.
    @ViewBuilder
    private var textAndMeta: some View {
        if showsMeta {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .lastTextBaseline, spacing: 8) {
                    messageText
                    meta
                }
                VStack(alignment: .trailing, spacing: 2) {
                    messageText
                    meta
                }
            }
        } else {
            messageText
        }
    }

    private var messageText: some View {
        Text(message.text)
            .font(.body)
            .foregroundStyle(foreground)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.disabled)
    }

    private func replyQuote(_ quote: ReplyQuote) -> some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 1)
                .fill(CentyColors.primaryBlue)
                .frame(width: 2)
            VStack(alignment: .leading, spacing: 1) {
                Text(quote.senderName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(CentyColors.accentText)
                Text(quote.text)
                    .font(.caption)
                    .foregroundStyle(CentyColors.textSecondary)
                    .lineLimit(2)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Ответ на сообщение \(quote.senderName): \(quote.text)"))
    }

    private var meta: some View {
        HStack(spacing: 4) {
            if message.updatedAt != nil && !message.isDeleted {
                Text("изм.")
                    .font(.caption2)
                    .foregroundStyle(CentyColors.textDim)
            }
            Text(ChatDates.bubbleTime(message.createdAt))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(CentyColors.textDim)
            if isCurrentUser && !message.isDeleted {
                DeliveryStatusView(mark: DeliveryMark(message))
            }
        }
        .fixedSize()
    }

    private var failedRow: some View {
        VStack(alignment: .trailing, spacing: 0) {
            Label {
                Text(message.failureReason.map { AppCopy.deliveryFailed(reason: $0) } ?? AppCopy.deliveryFailed)
            } icon: {
                Image(systemName: "exclamationmark.circle.fill")
            }
            .font(.footnote)
            .foregroundStyle(CentyColors.dangerText)
            .multilineTextAlignment(.trailing)
            HStack(spacing: 16) {
                Button(AppCopy.deliveryRetry) { onAction(.retry, message) }
                    .buttonStyle(CentyLinkButtonStyle())
                    .accessibilityIdentifier("message-retry")
                Button(AppCopy.deliveryDiscard, role: .destructive) { onAction(.delete, message) }
                    .buttonStyle(CentyLinkButtonStyle(tint: CentyColors.dangerText))
                    .accessibilityIdentifier("message-discard")
            }
            .font(.footnote)
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
                    onCopied()
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

/// An image of a message (design brief component 15): a quiet placeholder in the picture's
/// proportions (no jump on load), the picture fading in, an upload progress ring while it goes up,
/// the download failure with «Повторить» in the viewer.
struct AttachmentImageView: View {
    let attachment: MessageAttachment
    let thumbnails: AttachmentThumbnails
    let upload: LocalUpload?
    let transfer: AttachmentOpener.Transfer?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var image: UIImage?

    private var aspectRatio: CGFloat {
        guard let width = attachment.width, let height = attachment.height, width > 0, height > 0 else { return 4 / 3 }
        return min(max(CGFloat(width) / CGFloat(height), 0.5), 2.5)
    }

    var body: some View {
        ZStack {
            Rectangle()
                .fill(CentyColors.sunken)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            } else {
                Image(systemName: "photo")
                    .font(.title2)
                    .foregroundStyle(CentyColors.textDim)
            }
            if let progress = upload?.progress {
                ZStack {
                    Circle()
                        .stroke(Color.white.opacity(0.35), lineWidth: 3)
                    Circle()
                        .trim(from: 0, to: progress)
                        .stroke(Color.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: 36, height: 36)
                .padding(8)
                .background(Circle().fill(Color.black.opacity(0.35)))
                .accessibilityLabel(Text("Отправка \(Int(progress * 100))%"))
            }
        }
        .frame(width: 220)
        .aspectRatio(aspectRatio, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .padding(4)
        .animation(reduceMotion ? nil : .easeOut(duration: CentyMotion.slow), value: image != nil)
        .task(id: attachment) { await load() }
    }

    private func load() async {
        if let local = attachment.localFile ?? upload?.fileURL {
            image = await Task.detached { UIImage(contentsOfFile: local.path)?.preparingThumbnail(of: CGSize(width: 480, height: 480)) }.value
            return
        }
        guard let id = attachment.fileId else { return }
        if let data = await thumbnails.data(for: id) {
            image = await Task.detached { UIImage(data: data)?.preparingForDisplay() }.value
        }
    }
}

/// A file of a message: a glyph for its kind (PDF, document, archive…), name and size, the open
/// action; while it goes up or down, its progress; when its download failed, why.
struct AttachmentFileTile: View {
    let attachment: MessageAttachment
    let upload: LocalUpload?
    let transfer: AttachmentOpener.Transfer?
    let isOutgoing: Bool

    private var failed: Bool {
        if case .failed = transfer { return true }
        return false
    }

    private var glyph: String {
        let name = attachment.name.lowercased()
        let mime = attachment.mimeType?.lowercased() ?? ""
        if mime == "application/pdf" || name.hasSuffix(".pdf") { return "doc.richtext.fill" }
        if name.hasSuffix(".zip") || name.hasSuffix(".rar") || name.hasSuffix(".7z") { return "doc.zipper" }
        if name.hasSuffix(".xls") || name.hasSuffix(".xlsx") || name.hasSuffix(".csv") { return "tablecells.fill" }
        return "doc.text.fill"
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

    private var progress: Double? {
        if case .running(let value) = transfer { return value ?? 0 }
        return upload?.progress
    }

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(isOutgoing ? CentyColors.primarySoft : CentyColors.sunken)
                    .frame(width: 40, height: 40)
                if let progress {
                    ZStack {
                        Circle()
                            .stroke(CentyColors.primaryLine, lineWidth: 2.5)
                        Circle()
                            .trim(from: 0, to: progress)
                            .stroke(CentyColors.primaryBlue, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                    }
                    .frame(width: 24, height: 24)
                } else {
                    Image(systemName: failed ? "exclamationmark.triangle.fill" : glyph)
                        .font(.title3)
                        .foregroundStyle(failed ? CentyColors.dangerText : CentyColors.accentText)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(isOutgoing ? CentyColors.accentText : CentyColors.textStrong)
                    .lineLimit(2)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(failed ? CentyColors.dangerText : CentyColors.textDim)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.top, 10)
        .frame(minWidth: 200, minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text(failed ? "Повторить загрузку" : "Открыть файл"))
    }
}

#if DEBUG
#Preview("Bubbles") {
    ScrollView {
        VStack(spacing: 2) {
            ForEach(Array(PreviewData.messages().enumerated()), id: \.offset) { index, message in
                MessageBubbleView(
                    message: message,
                    isCurrentUser: message.senderId == PreviewData.me.id,
                    showSenderHeader: false,
                    showsMeta: true,
                    transfer: nil,
                    thumbnails: AttachmentThumbnails(environment: ServerEnvironment(validating: "https://preview.invalid")!, token: { nil }, live: false),
                    onAction: { _, _ in },
                    onOpenAttachment: { _ in }
                )
                .padding(.top, index == 0 ? 0 : 6)
            }
        }
        .padding(12)
    }
    .background(CentyColors.canvas)
    .previewEnvironment()
}
#endif
