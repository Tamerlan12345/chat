import Foundation

/// The file of a message, from the server's record (`metadata_json`, `file_original_name`,
/// `file_width`) or, before the server confirmed it, from the file picked on this device.
struct MessageAttachment: Equatable, Sendable, Identifiable {
    var id: String {
        if let fileId { return "file:\(fileId)" }
        return "local:\(localFile?.path ?? name)"
    }

    /// Server id of the file; nil until uploaded.
    let fileId: Int64?
    let name: String
    let size: Int64?
    let mimeType: String?
    /// Drawn inline from the server's thumbnail (only formats the server can thumbnail).
    let isImage: Bool
    let width: Int?
    let height: Int?
    /// The picked file, while it is on its way to the server.
    let localFile: URL?

    static func of(_ message: Message) -> MessageAttachment? {
        guard !message.isDeleted else { return nil }
        let metadata = message.pendingMetadata ?? message.metadataJson.flatMap { JSONValue.parse($0) }
        let legacy = message.metadata
        if let upload = message.localUpload {
            return MessageAttachment(
                fileId: metadata?["file_id"]?.int64,
                name: upload.name,
                size: upload.size,
                mimeType: upload.mimeType,
                isImage: AttachmentRules.isImage(name: upload.name, mimeType: upload.mimeType),
                width: message.fileWidth,
                height: message.fileHeight,
                localFile: upload.fileURL
            )
        }
        guard message.type != .text else { return nil }
        let name = [message.fileOriginalName, legacy?.fileName, metadata?["file_name"]?.string, message.text]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? String(localized: "Файл")
        let mimeType = metadata?["mimeType"]?.string ?? metadata?["mime_type"]?.string ?? legacy?.mimeType
        return MessageAttachment(
            fileId: metadata?["file_id"]?.int64 ?? legacy?.fileId,
            name: name,
            size: metadata?["size"]?.int64 ?? legacy?.fileSize,
            mimeType: mimeType,
            isImage: AttachmentRules.isImage(name: name, mimeType: mimeType),
            width: message.fileWidth ?? metadata?["width"]?.int64.map { Int($0) },
            height: message.fileHeight ?? metadata?["height"]?.int64.map { Int($0) },
            localFile: nil
        )
    }
}

/// What the long-press menu offers, in the brief's order (Ответить, Копировать, Редактировать,
/// Удалить, Пожаловаться). Edit and delete follow the server's rules (`canEdit`, `canDelete`); an
/// unsent message can only be copied or withdrawn (a failed one also retried); a deleted message
/// offers nothing.
enum MessageMenuPolicy {
    enum Action: Equatable, Sendable {
        case reply, copy, edit, retry, delete, report, blockSender
    }

    static func actions(for message: Message, isOwn: Bool, canEdit: Bool, canDelete: Bool) -> [Action] {
        guard !message.isDeleted else { return [] }
        let unsent = message.sendState != nil
        var actions: [Action] = []
        if !unsent { actions.append(.reply) }
        if message.type == .text, !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { actions.append(.copy) }
        if !unsent, isOwn, canEdit, message.type == .text { actions.append(.edit) }
        if message.sendState == .failed { actions.append(.retry) }
        if unsent || canDelete { actions.append(.delete) }
        if !unsent, !isOwn {
            actions.append(.report)
            actions.append(.blockSender)
        }
        return actions
    }
}
